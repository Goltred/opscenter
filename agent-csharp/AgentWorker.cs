using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace OpsCenter.Agent;

public sealed class AgentWorker : BackgroundService
{
    private readonly ILogger<AgentWorker> _log;
    private readonly AgentConfig _cfg;
    private readonly SteamCmdRunner _steam;
    private readonly InstanceProcessManager _instances;
    private readonly HostBootstrapper _bootstrap;
    private readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    public AgentWorker(ILogger<AgentWorker> log, AgentConfig cfg)
    {
        _log = log;
        _cfg = cfg;
        _steam = new SteamCmdRunner(cfg);
        _instances = new InstanceProcessManager(cfg);
        _bootstrap = new HostBootstrapper(cfg);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunSession(stoppingToken);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "agent session ended");
            }
            await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken);
        }
    }

    private async Task RunSession(CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("X-Host-Id", _cfg.HostId);
        if (!string.IsNullOrWhiteSpace(_cfg.EnrollToken))
            ws.Options.SetRequestHeader("X-Enroll-Token", _cfg.EnrollToken);

        _log.LogInformation("Connecting to {Url} as host {HostId}", _cfg.ControlPlaneUrl, _cfg.HostId);
        await ws.ConnectAsync(new Uri(_cfg.ControlPlaneUrl), ct);

        _instances.OnLog = (instanceId, line) =>
        {
            _ = Send(ws, new Envelope
            {
                Kind = "progress",
                Id = "instance-log:" + instanceId,
                Op = "instance.status",
                Result = new ResultBody
                {
                    Ok = true,
                    Final = false,
                    Stage = "console",
                    LogLine = line,
                    Data = new Dictionary<string, object> { ["instanceId"] = instanceId },
                },
            }, ct);
        };

        await Send(ws, new Envelope
        {
            Kind = "hello",
            Id = Guid.NewGuid().ToString("N"),
            Hello = new HelloBody
            {
                HostId = _cfg.HostId,
                AgentVersion = "0.2.5-csharp",
                Capabilities = ["steamcmd", "process", "bootstrap", "config", "files", "instance-logs", "a2s", "reconcile", "dlc", "headless", "hcgroup"],
            },
        }, ct);

        var heartbeat = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                var snap = _instances.Snapshot();
                var instances = new Dictionary<string, object>();
                foreach (var kv in snap)
                {
                    if (kv.Key.StartsWith("g:", StringComparison.Ordinal)) continue;
                    var uptime = kv.Value.StartedAt.HasValue
                        ? (int)(DateTime.UtcNow - kv.Value.StartedAt.Value).TotalSeconds
                        : 0;
                    instances[kv.Key] = new Dictionary<string, object?>
                    {
                        ["state"] = kv.Value.State,
                        ["pid"] = kv.Value.Pid,
                        ["port"] = kv.Value.Port,
                        ["players"] = kv.Value.Players,
                        ["maxPlayers"] = kv.Value.MaxPlayers,
                        ["uptimeSec"] = uptime,
                        ["queryOk"] = kv.Value.QueryOk,
                        ["queryError"] = kv.Value.QueryError,
                        ["hostname"] = kv.Value.QueryHostname,
                        ["map"] = kv.Value.QueryMap,
                        ["password"] = kv.Value.QueryPassword,
                        ["queryPort"] = kv.Value.QueryPort,
                        ["queriedAt"] = kv.Value.QueriedAt?.ToString("o"),
                        ["adopted"] = kv.Value.Adopted,
                        ["headless"] = kv.Value.Headless.Select(h => new Dictionary<string, object?>
                        {
                            ["name"] = h.Name,
                            ["state"] = h.State,
                            ["pid"] = h.Pid,
                            ["port"] = h.Port,
                            ["error"] = h.Error,
                        }).ToList(),
                    };
                }

                await Send(ws, new Envelope
                {
                    Kind = "heartbeat",
                    Id = Guid.NewGuid().ToString("N"),
                    Heartbeat = new HeartbeatBody
                    {
                        Instances = instances,
                        HcGroups = _instances.HcGroupsHeartbeatSnapshot(),
                        Orphans = _instances.ListOrphanReports(),
                        SteamcmdRunning = _steam.IsRunning,
                        SteamcmdPid = _steam.Pid,
                    },
                }, ct);
                await Task.Delay(TimeSpan.FromSeconds(10), ct);
            }
        }, ct);

        var buffer = new byte[1024 * 256];
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            using var ms = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct);
                    return;
                }
                ms.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            var json = Encoding.UTF8.GetString(ms.ToArray());
            Envelope? env;
            try { env = JsonSerializer.Deserialize<Envelope>(json, _json); }
            catch { continue; }
            if (env is null || env.Kind != "command") continue;

            _ = Task.Run(() => HandleCommand(ws, env, ct), ct);
        }

        await heartbeat;
        _instances.OnLog = null;
    }

    private async Task HandleCommand(ClientWebSocket ws, Envelope cmd, CancellationToken ct)
    {
        async Task Progress(ResultBody r)
        {
            // Single envelope: hub keys steamcmd logs off host id via "steamcmd:{hostId}".
            await Send(ws, new Envelope
            {
                Kind = "progress",
                Id = "steamcmd:" + _cfg.HostId,
                Op = cmd.Op,
                Result = r,
            }, ct);
        }

        try
        {
            ResultBody final;
            switch (cmd.Op)
            {
                case "ping":
                    final = new ResultBody { Ok = true, Final = true, Message = "pong" };
                    break;
                case "host.info":
                {
                    final = _bootstrap.Info();
                    final.Data ??= new Dictionary<string, object>();
                    final.Data["steamcmdRunning"] = _steam.IsRunning;
                    final.Data["steamcmdPid"] = _steam.Pid ?? 0;
                    break;
                }
                case "host.bootstrap":
                {
                    var payload = Deserialize<HostBootstrapPayload>(cmd.Payload) ?? new HostBootstrapPayload();
                    final = _bootstrap.Prepare(payload);
                    break;
                }
                case "host.dlc.check":
                {
                    var payload = Deserialize<DlcCheckPayload>(cmd.Payload) ?? new DlcCheckPayload();
                    final = DlcCheck.Check(_cfg, payload);
                    break;
                }
                case "instance.start":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    final = _instances.Start(payload);
                    break;
                }
                case "instance.stop":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    final = _instances.Stop(payload);
                    break;
                }
                case "instance.restart":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    final = _instances.Restart(payload);
                    break;
                }
                case "instance.status":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    var root = string.IsNullOrWhiteSpace(payload.ArmaRoot) ? _cfg.ArmaRoot : payload.ArmaRoot!;
                    var profileDir = string.IsNullOrWhiteSpace(payload.ProfileDir) ? "profiles" : payload.ProfileDir!;
                    var profilePath = Path.IsPathRooted(profileDir) ? profileDir : Path.Combine(root, profileDir);
                    final = _instances.Status(payload.InstanceId, profilePath, payload.FollowLogs, payload.Port > 0 ? payload.Port : null);
                    break;
                }
                case "instance.reconcile":
                {
                    var payload = Deserialize<ReconcilePayload>(cmd.Payload) ?? new ReconcilePayload();
                    final = _instances.Reconcile(payload);
                    break;
                }
                case "instance.headless.scale":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    final = _instances.ScaleHeadless(payload);
                    break;
                }
                case "instance.headless.restart":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    final = _instances.RestartHeadless(payload);
                    break;
                }
                case "instance.headless.stop":
                {
                    var payload = Deserialize<InstanceControlPayload>(cmd.Payload) ?? new InstanceControlPayload();
                    final = _instances.StopHeadlessOne(payload);
                    break;
                }
                case "hcgroup.scale":
                {
                    var payload = Deserialize<HcGroupControlPayload>(cmd.Payload) ?? new HcGroupControlPayload();
                    final = _instances.ScaleHcGroup(payload);
                    break;
                }
                case "hcgroup.restart":
                {
                    var payload = Deserialize<HcGroupControlPayload>(cmd.Payload) ?? new HcGroupControlPayload();
                    final = _instances.RestartHcGroup(payload);
                    break;
                }
                case "hcgroup.stop":
                {
                    var payload = Deserialize<HcGroupControlPayload>(cmd.Payload) ?? new HcGroupControlPayload();
                    final = _instances.StopHcGroup(payload);
                    break;
                }
                case "config.apply":
                {
                    var payload = Deserialize<ApplyConfigPayload>(cmd.Payload) ?? new ApplyConfigPayload();
                    final = ConfigApplier.Apply(_cfg, payload);
                    break;
                }
                case "file.deploy":
                {
                    var payload = Deserialize<FileDeployPayload>(cmd.Payload) ?? new FileDeployPayload();
                    final = FileOps.Deploy(_cfg, payload);
                    break;
                }
                case "file.list":
                {
                    var payload = Deserialize<FileListPayload>(cmd.Payload) ?? new FileListPayload();
                    final = FileOps.List(_cfg, payload);
                    break;
                }
                case "file.read":
                {
                    var payload = Deserialize<FileReadPayload>(cmd.Payload) ?? new FileReadPayload();
                    final = FileOps.Read(_cfg, payload);
                    break;
                }
                case "file.delete":
                {
                    var payload = Deserialize<FileDeletePayload>(cmd.Payload) ?? new FileDeletePayload();
                    final = FileOps.Delete(_cfg, payload);
                    break;
                }
                case "mod.check":
                {
                    var payload = Deserialize<ModCheckPayload>(cmd.Payload) ?? new ModCheckPayload();
                    final = ModsLibrary.Check(_cfg, payload);
                    break;
                }
                case "keys.sync":
                {
                    var payload = Deserialize<KeysSyncPayload>(cmd.Payload) ?? new KeysSyncPayload();
                    final = KeysSync.Sync(_cfg, payload);
                    break;
                }
                case "mod.download":
                {
                    var payload = Deserialize<DownloadModPayload>(cmd.Payload) ?? new DownloadModPayload();
                    final = await _steam.DownloadAsync(cmd.Id, payload, Progress, ct);
                    break;
                }
                case "steam.app.update":
                {
                    var payload = Deserialize<UpdateAppPayload>(cmd.Payload) ?? new UpdateAppPayload();
                    final = await _steam.UpdateAppAsync(cmd.Id, payload, Progress, ct);
                    break;
                }
                case "mod.download.cancel":
                {
                    var payload = Deserialize<CancelPayload>(cmd.Payload) ?? new CancelPayload();
                    final = _steam.Cancel(payload.JobId ?? cmd.Id);
                    break;
                }
                default:
                    final = new ResultBody
                    {
                        Ok = false,
                        Final = true,
                        Error = $"op '{cmd.Op}' not implemented in C# agent yet",
                        Message = "not implemented",
                    };
                    break;
            }

            await Send(ws, new Envelope { Kind = "result", Id = cmd.Id, Op = cmd.Op, Result = final }, ct);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "command {Op} failed", cmd.Op);
            await Send(ws, new Envelope
            {
                Kind = "result",
                Id = cmd.Id,
                Op = cmd.Op,
                Result = new ResultBody { Ok = false, Final = true, Error = ex.Message },
            }, ct);
        }
    }

    private T? Deserialize<T>(object? payload)
    {
        if (payload is null) return default;
        return JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(payload), _json);
    }

    private static async Task Send(ClientWebSocket ws, Envelope env, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(env));
        await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }
}

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Serialization;

namespace A3Panel.Agent;

public sealed class InstanceControlPayload
{
    [JsonPropertyName("instanceId")] public string InstanceId { get; set; } = "";
    [JsonPropertyName("port")] public int Port { get; set; } = 2302;
    [JsonPropertyName("profileDir")] public string? ProfileDir { get; set; }
    [JsonPropertyName("armaRoot")] public string? ArmaRoot { get; set; }
    [JsonPropertyName("executable")] public string? Executable { get; set; }
    [JsonPropertyName("args")] public string[]? Args { get; set; }
    [JsonPropertyName("workingDirectory")] public string? WorkingDirectory { get; set; }
    /// <summary>When set, start (true) or stop (false) RPT log tailing for the UI console.</summary>
    [JsonPropertyName("followLogs")] public bool? FollowLogs { get; set; }
    /// <summary>Local headless clients to start with the dedicated server.</summary>
    [JsonPropertyName("headless")] public List<HeadlessSpecPayload>? Headless { get; set; }
    [JsonPropertyName("desiredCount")] public int? DesiredCount { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
}

public sealed class HeadlessSpecPayload
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("args")] public string[]? Args { get; set; }
    [JsonPropertyName("profileDir")] public string? ProfileDir { get; set; }
    [JsonPropertyName("port")] public int Port { get; set; }
}

public sealed class ApplyConfigPayload
{
    [JsonPropertyName("instanceId")] public string InstanceId { get; set; } = "";
    [JsonPropertyName("profileDir")] public string? ProfileDir { get; set; }
    [JsonPropertyName("files")] public List<ConfigFilePayload>? Files { get; set; }
}

public sealed class ConfigFilePayload
{
    [JsonPropertyName("relativePath")] public string RelativePath { get; set; } = "";
    [JsonPropertyName("content")] public string Content { get; set; } = "";
}

public sealed class HostBootstrapPayload
{
    [JsonPropertyName("ensureSteamCmd")] public bool EnsureSteamCmd { get; set; } = true;
    [JsonPropertyName("ensureDirs")] public bool EnsureDirs { get; set; } = true;
}

public sealed class HeadlessRuntimeState
{
    public string Name { get; set; } = "";
    public string State { get; set; } = "stopped";
    public int? Pid { get; set; }
    public int Port { get; set; }
    public string? Error { get; set; }
    public DateTime? StartedAt { get; set; }
    public string ProfilePath { get; set; } = "";
    public string[] Args { get; set; } = Array.Empty<string>();
}

public sealed class InstanceRuntimeState
{
    public string InstanceId { get; set; } = "";
    public string State { get; set; } = "stopped";
    public int? Pid { get; set; }
    public int Port { get; set; } = 2302;
    public int Players { get; set; }
    public int MaxPlayers { get; set; }
    public DateTime? StartedAt { get; set; }
    public string ProfilePath { get; set; } = "";
    /// <summary>True when we reattached to a process that was already running (agent restart).</summary>
    public bool Adopted { get; set; }

    // Steam A2S (launcher / browser view)
    public bool QueryOk { get; set; }
    public string? QueryError { get; set; }
    public string QueryHostname { get; set; } = "";
    public string QueryMap { get; set; } = "";
    public bool QueryPassword { get; set; }
    public int QueryPort { get; set; }
    public DateTime? QueriedAt { get; set; }

    public List<HeadlessRuntimeState> Headless { get; set; } = new();
}

public sealed class ReconcileInstancePayload
{
    [JsonPropertyName("instanceId")] public string InstanceId { get; set; } = "";
    [JsonPropertyName("port")] public int Port { get; set; } = 2302;
    [JsonPropertyName("profileDir")] public string? ProfileDir { get; set; }
    [JsonPropertyName("armaRoot")] public string? ArmaRoot { get; set; }
}

public sealed class ReconcilePayload
{
    [JsonPropertyName("instances")] public List<ReconcileInstancePayload>? Instances { get; set; }
}

public sealed class ArmaProcessInfo
{
    public int Pid { get; init; }
    public int? Port { get; init; }
    public string CommandLine { get; init; } = "";
    public string? ProfileHint { get; init; }
}

/// <summary>
/// Tracks Arma dedicated server + local headless client processes per instance id.
/// </summary>
public sealed class InstanceProcessManager
{
    private readonly AgentConfig _cfg;
    private readonly ConcurrentDictionary<string, Process> _procs = new();
    /// <summary>Key: "{instanceId}/{hcName}"</summary>
    private readonly ConcurrentDictionary<string, Process> _hcProcs = new();
    private readonly ConcurrentDictionary<string, InstanceRuntimeState> _states = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _logTails = new();

    /// <summary>instanceId, log line — wired by AgentWorker to the control plane.</summary>
    public Action<string, string>? OnLog { get; set; }

    public InstanceProcessManager(AgentConfig cfg) => _cfg = cfg;

    private static string HcKey(string instanceId, string name) => instanceId + "/" + name;

    public IReadOnlyDictionary<string, InstanceRuntimeState> Snapshot()
    {
        foreach (var kv in _procs.ToArray())
        {
            if (kv.Value.HasExited)
            {
                _procs.TryRemove(kv.Key, out _);
                if (_states.TryGetValue(kv.Key, out var st))
                {
                    // Process died — try to re-adopt another matching orphan (unlikely), else stop.
                    if (!TryAdopt(kv.Key, st.Port, st.ProfilePath, out _))
                    {
                        ClearQuery(st);
                        st.State = "stopped";
                        st.Pid = null;
                        st.Adopted = false;
                        StopAllHeadless(kv.Key);
                    }
                }
                else
                {
                    _states[kv.Key] = new InstanceRuntimeState { InstanceId = kv.Key, State = "stopped" };
                }
            }
            else
            {
                RefreshQuery(kv.Key, force: false);
                RefreshHeadlessStates(kv.Key, requireServerQuery: !kv.Key.StartsWith("g:", StringComparison.Ordinal));
            }
        }

        foreach (var kv in _hcProcs.ToArray())
        {
            if (!kv.Value.HasExited) continue;
            _hcProcs.TryRemove(kv.Key, out _);
            var parts = kv.Key.Split('/', 2);
            if (parts.Length != 2 || !_states.TryGetValue(parts[0], out var st)) continue;
            var hc = st.Headless.FirstOrDefault(h =>
                string.Equals(h.Name, parts[1], StringComparison.OrdinalIgnoreCase));
            if (hc == null) continue;
            hc.State = "failed";
            try { hc.Error = $"process exited (code {kv.Value.ExitCode})"; }
            catch { hc.Error = "process exited"; }
            hc.Pid = null;
        }

        // Known instances with no live handle — try adopt (agent restart / lost handle).
        foreach (var kv in _states.ToArray())
        {
            if (kv.Key.StartsWith("g:", StringComparison.Ordinal))
            {
                TryAdoptHeadless(kv.Key, kv.Value);
                RefreshHeadlessStates(kv.Key, requireServerQuery: false);
                continue;
            }
            if (_procs.ContainsKey(kv.Key)) continue;
            if (kv.Value.Port <= 0 && string.IsNullOrWhiteSpace(kv.Value.ProfilePath)) continue;
            if (TryAdopt(kv.Key, kv.Value.Port, kv.Value.ProfilePath, out _))
            {
                RefreshQuery(kv.Key, force: false);
                TryAdoptHeadless(kv.Key, kv.Value);
            }
        }

        return _states;
    }

    /// <summary>Attach to an already-running Arma process for this instance (port / profile / pidfile).</summary>
    public bool TryAdopt(string instanceId, int port, string? profilePath, out string note)
    {
        note = "";
        if (string.IsNullOrWhiteSpace(instanceId))
        {
            note = "instanceId required";
            return false;
        }

        if (_procs.TryGetValue(instanceId, out var existing) && !existing.HasExited)
        {
            note = "already tracked";
            return true;
        }

        var root = _cfg.ArmaRoot;
        var profile = string.IsNullOrWhiteSpace(profilePath)
            ? Path.Combine(root, "profiles")
            : (Path.IsPathRooted(profilePath) ? profilePath : Path.Combine(root, profilePath));
        var gamePort = port > 0 ? port : 2302;

        int? pid = TryReadPidFile(profile);
        if (pid is int filePid)
        {
            try
            {
                var proc = Process.GetProcessById(filePid);
                if (!proc.HasExited && IsArmaProcessName(proc.ProcessName))
                {
                    AttachProcess(instanceId, proc, gamePort, profile, adopted: true);
                    note = $"adopted pidfile pid {filePid}";
                    return true;
                }
            }
            catch
            {
                /* stale pidfile */
            }
        }

        foreach (var matchPid in FindMatchingArmaPids(profile, gamePort))
        {
            // Don't steal a PID already tracked under another instance.
            if (_procs.Any(kv => !kv.Value.HasExited && kv.Value.Id == matchPid))
                continue;
            try
            {
                var proc = Process.GetProcessById(matchPid);
                if (proc.HasExited) continue;
                AttachProcess(instanceId, proc, gamePort, profile, adopted: true);
                note = $"adopted orphan pid {matchPid} on port {gamePort}";
                return true;
            }
            catch
            {
                /* ignore */
            }
        }

        note = "no matching Arma process";
        return false;
    }

    private void AttachProcess(string instanceId, Process proc, int port, string profilePath, bool adopted)
    {
        _procs[instanceId] = proc;
        if (!_states.TryGetValue(instanceId, out var st))
        {
            st = new InstanceRuntimeState { InstanceId = instanceId };
            _states[instanceId] = st;
        }
        st.Pid = proc.Id;
        st.Port = port;
        st.ProfilePath = profilePath;
        st.Adopted = adopted;
        st.StartedAt ??= DateTime.UtcNow;
        st.State = "starting";
        TryWritePidFile(profilePath, proc.Id);
        RefreshQuery(instanceId, force: true);
    }

    private static bool IsArmaProcessName(string name) =>
        name.Equals("arma3server_x64", StringComparison.OrdinalIgnoreCase) ||
        name.Equals("arma3server", StringComparison.OrdinalIgnoreCase);

    public ResultBody Reconcile(ReconcilePayload p)
    {
        var adopted = new List<string>();
        var missing = new List<string>();
        foreach (var item in p.Instances ?? [])
        {
            if (string.IsNullOrWhiteSpace(item.InstanceId)) continue;
            var root = string.IsNullOrWhiteSpace(item.ArmaRoot) ? _cfg.ArmaRoot : item.ArmaRoot!;
            var profileDir = string.IsNullOrWhiteSpace(item.ProfileDir) ? "profiles" : item.ProfileDir!;
            var profilePath = Path.IsPathRooted(profileDir) ? profileDir : Path.Combine(root, profileDir);
            var port = item.Port > 0 ? item.Port : 2302;

            // Remember identity even if nothing is running yet (for later Snapshot adopt).
            if (!_states.TryGetValue(item.InstanceId, out var st))
            {
                st = new InstanceRuntimeState { InstanceId = item.InstanceId, State = "stopped" };
                _states[item.InstanceId] = st;
            }
            st.Port = port;
            st.ProfilePath = profilePath;

            if (TryAdopt(item.InstanceId, port, profilePath, out var note))
                adopted.Add($"{item.InstanceId}: {note}");
            else
                missing.Add($"{item.InstanceId}: {note}");
        }

        var trackedPids = new HashSet<int>(_procs.Values.Where(x => !x.HasExited).Select(x => x.Id));
        var orphans = ListArmaProcesses()
            .Where(o => !trackedPids.Contains(o.Pid))
            .Select(o => new Dictionary<string, object?>
            {
                ["pid"] = o.Pid,
                ["port"] = o.Port,
                ["profileHint"] = o.ProfileHint,
                ["commandLine"] = Truncate(o.CommandLine, 240),
            })
            .ToList();

        return Ok(
            adopted.Count > 0
                ? $"reconciled: adopted {adopted.Count}, unmatched orphans {orphans.Count}"
                : $"reconciled: no adoptions, orphans {orphans.Count}",
            new Dictionary<string, object>
            {
                ["adopted"] = adopted.ToArray(),
                ["missing"] = missing.ToArray(),
                ["orphans"] = orphans,
            });
    }

    /// <summary>Untracked arma3server processes (for heartbeat / UI warnings).</summary>
    public List<Dictionary<string, object?>> ListOrphanReports()
    {
        var trackedPids = new HashSet<int>(_procs.Values.Where(x => !x.HasExited).Select(x => x.Id));
        foreach (var p in _hcProcs.Values.Where(x => !x.HasExited))
            trackedPids.Add(p.Id);
        return ListArmaProcesses()
            .Where(o => !trackedPids.Contains(o.Pid))
            .Select(o => new Dictionary<string, object?>
            {
                ["pid"] = o.Pid,
                ["port"] = o.Port,
                ["profileHint"] = o.ProfileHint,
                ["commandLine"] = Truncate(o.CommandLine, 240),
            })
            .ToList();
    }

    private static string Truncate(string s, int max) =>
        string.IsNullOrEmpty(s) || s.Length <= max ? s : s[..max] + "…";

    /// <summary>Steam A2S_INFO against localhost (gamePort+1). Updates players/map/hostname.</summary>
    public void RefreshQuery(string instanceId, bool force = true)
    {
        if (!_states.TryGetValue(instanceId, out var st)) return;
        if (!_procs.TryGetValue(instanceId, out var proc) || proc.HasExited)
        {
            ClearQuery(st);
            return;
        }

        if (!force && st.QueriedAt.HasValue && (DateTime.UtcNow - st.QueriedAt.Value).TotalSeconds < 8)
            return;

        var port = st.Port > 0 ? st.Port : 2302;
        var info = SteamA2S.QueryArma("127.0.0.1", port, timeoutMs: 700);
        st.QueriedAt = info.QueriedAt;
        st.QueryPort = info.QueryPort;
        if (info.Ok)
        {
            st.QueryOk = true;
            st.QueryError = null;
            st.QueryHostname = info.Hostname;
            st.QueryMap = info.Map;
            st.QueryPassword = info.Password;
            st.Players = info.Players;
            st.MaxPlayers = info.MaxPlayers;
            st.State = "running";
        }
        else
        {
            st.QueryOk = false;
            st.QueryError = info.Error;
            // Process is up but not answering Steam query yet → still starting.
            if (string.Equals(st.State, "running", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(st.State, "starting", StringComparison.OrdinalIgnoreCase))
                st.State = "starting";
        }
    }

    private static void ClearQuery(InstanceRuntimeState st)
    {
        st.QueryOk = false;
        st.QueryError = null;
        st.QueryHostname = "";
        st.QueryMap = "";
        st.QueryPassword = false;
        st.QueryPort = 0;
        st.QueriedAt = null;
        st.Players = 0;
        st.MaxPlayers = 0;
    }

    public ResultBody Start(InstanceControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.InstanceId))
            return Fail("instanceId required");

        var root = string.IsNullOrWhiteSpace(p.ArmaRoot) ? _cfg.ArmaRoot : p.ArmaRoot!;
        var profileDir = string.IsNullOrWhiteSpace(p.ProfileDir) ? "profiles" : p.ProfileDir!;
        var profilePath = Path.IsPathRooted(profileDir) ? profileDir : Path.Combine(root, profileDir);
        Directory.CreateDirectory(profilePath);

        // If already running, replace the process so new -mod= / -config args take effect.
        // (Adopted orphans / prior starts often have no mods — a plain Start must relaunch.)
        if (_procs.TryGetValue(p.InstanceId, out var existing) && !existing.HasExited)
        {
            var hasLaunchArgs = (p.Args?.Length ?? 0) > 0;
            if (!hasLaunchArgs)
            {
                if (!_states.TryGetValue(p.InstanceId, out var liveSt))
                {
                    liveSt = new InstanceRuntimeState
                    {
                        InstanceId = p.InstanceId,
                        State = "starting",
                        Pid = existing.Id,
                        Port = p.Port > 0 ? p.Port : 2302,
                    };
                    _states[p.InstanceId] = liveSt;
                }
                else if (p.Port > 0)
                {
                    liveSt.Port = p.Port;
                }
                RefreshQuery(p.InstanceId, force: true);
                return Ok("already running", StatusData(liveSt, existing.Id));
            }

            var stopResult = Stop(p);
            if (!stopResult.Ok)
                return Fail(stopResult.Error ?? "failed to stop existing process before relaunch");
        }

        var exeName = string.IsNullOrWhiteSpace(p.Executable) ? "arma3server_x64.exe" : p.Executable!;
        var exe = Path.IsPathRooted(exeName) ? exeName : Path.Combine(root, exeName);
        if (!File.Exists(exe))
        {
            var alt = Path.Combine(root, exeName.Equals("arma3server_x64.exe", StringComparison.OrdinalIgnoreCase)
                ? "arma3server.exe"
                : "arma3server_x64.exe");
            if (File.Exists(alt))
                exe = alt;
            else
                return Fail(
                    $"Arma dedicated server not installed at {root} (missing {Path.GetFileName(exe)}). " +
                    "Use Prepare host or Apply a Mission Profile to download the creatordlc branch via SteamCMD.");
        }

        var args = p.Args?.ToList() ?? new List<string>();
        var port = p.Port > 0 ? p.Port : 2302;
        var portFromArgs = args.Select(a =>
            {
                if (a.StartsWith("-port=", StringComparison.OrdinalIgnoreCase) &&
                    int.TryParse(a.AsSpan(6), out var parsed) && parsed > 0)
                    return (int?)parsed;
                return null;
            })
            .FirstOrDefault(x => x != null);
        if (portFromArgs is int ap) port = ap;

        if (!args.Any(a => a.StartsWith("-port=", StringComparison.OrdinalIgnoreCase)))
            args.Add($"-port={port}");
        if (!args.Any(a => a.StartsWith("-profiles=", StringComparison.OrdinalIgnoreCase)))
            args.Add($"-profiles={profilePath}");
        if (!args.Contains("-server", StringComparer.OrdinalIgnoreCase))
            args.Insert(0, "-server");

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            WorkingDirectory = string.IsNullOrWhiteSpace(p.WorkingDirectory) ? root : p.WorkingDirectory!,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        Process proc;
        try
        {
            proc = Process.Start(psi) ?? throw new InvalidOperationException("Process.Start returned null");
        }
        catch (Exception ex)
        {
            return Fail("failed to start: " + ex.Message);
        }

        _procs[p.InstanceId] = proc;
        _states[p.InstanceId] = new InstanceRuntimeState
        {
            InstanceId = p.InstanceId,
            State = "starting",
            Pid = proc.Id,
            Port = port,
            StartedAt = DateTime.UtcNow,
            MaxPlayers = 0,
            ProfilePath = profilePath,
        };
        TryWritePidFile(profilePath, proc.Id);
        // Immediate probe — usually fails for ~30–60s while Arma boots.
        RefreshQuery(p.InstanceId, force: true);
        var st = _states[p.InstanceId];
        st.Adopted = false;
        var modArg = args.FirstOrDefault(a => a.StartsWith("-mod=", StringComparison.OrdinalIgnoreCase));
        var modCount = string.IsNullOrEmpty(modArg)
            ? 0
            : modArg.Split('=', 2).Skip(1).FirstOrDefault()?.Split(';', StringSplitOptions.RemoveEmptyEntries).Length ?? 0;

        var hcStarted = 0;
        if (p.Headless != null)
        {
            // Align running HCs to the payload (stop extras, start missing).
            if (_states.TryGetValue(p.InstanceId, out var alignSt))
            {
                var keep = new HashSet<string>(
                    p.Headless.Select(h => h.Name),
                    StringComparer.OrdinalIgnoreCase);
                foreach (var hcRow in alignSt.Headless.ToArray())
                {
                    if (!keep.Contains(hcRow.Name))
                        StopOneHeadless(p.InstanceId, hcRow.Name);
                }
            }
            hcStarted = StartHeadlessList(p.InstanceId, root, p.Headless, pauseForServer: true);
        }
        RefreshHeadlessStates(p.InstanceId, requireServerQuery: true);

        return Ok("started", new Dictionary<string, object>
        {
            ["pid"] = proc.Id,
            ["state"] = st.State,
            ["port"] = port,
            ["queryOk"] = st.QueryOk,
            ["modCount"] = modCount,
            ["args"] = args.ToArray(),
            ["headless"] = HeadlessStatusList(st),
            ["headlessStarted"] = hcStarted,
        });
    }

    public ResultBody Stop(InstanceControlPayload p)
    {
        var instanceId = p.InstanceId ?? "";
        if (string.IsNullOrWhiteSpace(instanceId))
            return Fail("instanceId required");

        var root = string.IsNullOrWhiteSpace(p.ArmaRoot) ? _cfg.ArmaRoot : p.ArmaRoot!;
        var profileDir = string.IsNullOrWhiteSpace(p.ProfileDir) ? "profiles" : p.ProfileDir!;
        var profilePath = Path.IsPathRooted(profileDir) ? profileDir : Path.Combine(root, profileDir);
        var port = p.Port > 0 ? p.Port : 2302;

        var killed = new List<int>();
        var errors = new List<string>();

        // Stop headless clients first so they disconnect cleanly before the dedicated server dies.
        StopAllHeadless(instanceId);

        void TryKillProcess(Process proc, string label)
        {
            try
            {
                if (proc.HasExited) return;
                var pid = proc.Id;
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(20_000);
                killed.Add(pid);
            }
            catch (Exception ex)
            {
                errors.Add($"{label}: {ex.Message}");
            }
        }

        if (_procs.TryGetValue(instanceId, out var tracked))
        {
            TryKillProcess(tracked, "tracked");
            _procs.TryRemove(instanceId, out _);
        }

        var pidFromFile = TryReadPidFile(profilePath);
        if (pidFromFile is int filePid && filePid > 0 && !killed.Contains(filePid))
        {
            try
            {
                var proc = Process.GetProcessById(filePid);
                TryKillProcess(proc, $"pidfile:{filePid}");
            }
            catch (ArgumentException)
            {
                /* already gone */
            }
            catch (Exception ex)
            {
                errors.Add($"pidfile:{filePid}: {ex.Message}");
            }
        }

        foreach (var match in FindMatchingArmaPids(profilePath, port))
        {
            if (killed.Contains(match)) continue;
            try
            {
                var proc = Process.GetProcessById(match);
                TryKillProcess(proc, $"match:{match}");
            }
            catch (ArgumentException)
            {
                /* already gone */
            }
            catch (Exception ex)
            {
                errors.Add($"match:{match}: {ex.Message}");
            }
        }

        StopLogTail(instanceId);
        TryDeletePidFile(profilePath);
        _states[instanceId] = new InstanceRuntimeState { InstanceId = instanceId, State = "stopped", ProfilePath = profilePath };

        // Give Windows a moment to release handles on server.cfg / RPT / etc.
        if (killed.Count > 0)
            Thread.Sleep(750);

        if (errors.Count > 0 && killed.Count == 0)
            return Fail("stop failed: " + string.Join("; ", errors));

        return Ok(killed.Count > 0 ? "stopped" : "already stopped", new Dictionary<string, object>
        {
            ["state"] = "stopped",
            ["killed"] = killed.Count > 0,
            ["killedPids"] = killed.ToArray(),
            ["errors"] = errors.ToArray(),
        });
    }

    /// <summary>Compatibility wrapper used by Restart.</summary>
    public ResultBody Stop(string instanceId) =>
        Stop(new InstanceControlPayload { InstanceId = instanceId, ArmaRoot = _cfg.ArmaRoot, ProfileDir = "profiles" });

    /// <summary>Start or refresh RPT tail for a running instance (safe to call repeatedly).</summary>
    public void EnsureLogTail(string instanceId, string? profilePath = null)
    {
        if (string.IsNullOrWhiteSpace(instanceId)) return;
        var path = profilePath;
        if (string.IsNullOrWhiteSpace(path) && _states.TryGetValue(instanceId, out var st))
            path = st.ProfilePath;
        if (string.IsNullOrWhiteSpace(path))
        {
            path = Path.Combine(_cfg.ArmaRoot, "profiles");
        }
        if (_states.TryGetValue(instanceId, out var state))
            state.ProfilePath = path;

        StopLogTail(instanceId);
        var cts = new CancellationTokenSource();
        _logTails[instanceId] = cts;
        _ = Task.Run(() => TailRptLoop(instanceId, path, cts.Token), cts.Token);
    }

    public void StopLogTail(string instanceId)
    {
        if (_logTails.TryRemove(instanceId, out var cts))
        {
            try { cts.Cancel(); cts.Dispose(); } catch { /* ignore */ }
        }
    }

    private async Task TailRptLoop(string instanceId, string profilePath, CancellationToken ct)
    {
        Emit(instanceId, $"[a3panel] watching Arma RPT under {profilePath}");
        string? currentFile = null;
        long position = 0;
        var waited = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (_procs.TryGetValue(instanceId, out var proc) && proc.HasExited)
                {
                    Emit(instanceId, $"[a3panel] process exited (code {proc.ExitCode})");
                    break;
                }

                var newest = FindNewestRpt(profilePath);
                if (newest is null)
                {
                    waited += 1500;
                    if (waited == 1500 || waited % 15000 == 0)
                        Emit(instanceId, "[a3panel] waiting for .rpt file (Arma writes logs after startup)…");
                    await Task.Delay(1500, ct);
                    continue;
                }

                if (!string.Equals(newest, currentFile, StringComparison.OrdinalIgnoreCase))
                {
                    currentFile = newest;
                    var len = new FileInfo(newest).Length;
                    // On first attach, show recent history; on rotate, start near end.
                    position = len > 96_000 ? len - 96_000 : 0;
                    Emit(instanceId, $"[a3panel] tailing {Path.GetFileName(newest)}");
                }

                await using var fs = new FileStream(
                    newest,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);
                if (position > fs.Length) position = 0;
                fs.Seek(position, SeekOrigin.Begin);
                using var reader = new StreamReader(fs, detectEncodingFromByteOrderMarks: true);
                while (!ct.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(ct);
                    if (line is null) break;
                    if (line.Length > 0) Emit(instanceId, line);
                }
                position = fs.Position;
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Emit(instanceId, $"[a3panel] log tail error: {ex.Message}");
            }

            try { await Task.Delay(400, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void Emit(string instanceId, string line)
    {
        try { OnLog?.Invoke(instanceId, line); }
        catch { /* ignore */ }
    }

    private static string? FindNewestRpt(string profilePath)
    {
        if (string.IsNullOrWhiteSpace(profilePath) || !Directory.Exists(profilePath)) return null;
        try
        {
            var files = Directory.EnumerateFiles(profilePath, "*.rpt", SearchOption.AllDirectories)
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .ThenByDescending(f => f.Length)
                .ToList();
            return files.FirstOrDefault()?.FullName;
        }
        catch
        {
            return null;
        }
    }

    public ResultBody Restart(InstanceControlPayload p)
    {
        Stop(p);
        return Start(p);
    }

    public ResultBody Status(string instanceId, string? profilePath = null, bool? followLogs = null, int? port = null)
    {
        var gamePort = port is int gp && gp > 0 ? gp : 2302;
        var profile = string.IsNullOrWhiteSpace(profilePath)
            ? Path.Combine(_cfg.ArmaRoot, "profiles")
            : profilePath!;

        if (port is int p && p > 0)
        {
            if (!_states.TryGetValue(instanceId, out var remembered))
            {
                remembered = new InstanceRuntimeState { InstanceId = instanceId, State = "stopped" };
                _states[instanceId] = remembered;
            }
            remembered.Port = p;
            if (!string.IsNullOrWhiteSpace(profilePath))
                remembered.ProfilePath = profile;
        }

        // Reattach orphan before snapshot reporting.
        TryAdopt(instanceId, gamePort, profile, out _);

        Snapshot();
        if (followLogs == true)
            EnsureLogTail(instanceId, profile);
        else if (followLogs == false)
            StopLogTail(instanceId);

        if (_procs.TryGetValue(instanceId, out var proc) && !proc.HasExited)
        {
            RefreshQuery(instanceId, force: true);
            if (_states.TryGetValue(instanceId, out var st))
                return Ok(st.State, StatusData(st, proc.Id));
            return Ok("starting", new Dictionary<string, object>
            {
                ["state"] = "starting",
                ["pid"] = proc.Id,
                ["players"] = 0,
                ["maxPlayers"] = 0,
                ["uptimeSec"] = 0,
                ["queryOk"] = false,
                ["adopted"] = true,
            });
        }

        if (_states.TryGetValue(instanceId, out var stopped))
        {
            ClearQuery(stopped);
            stopped.State = "stopped";
            stopped.Pid = null;
            stopped.Adopted = false;
            return Ok("stopped", StatusData(stopped, 0));
        }
        return Ok("stopped", new Dictionary<string, object> { ["state"] = "stopped", ["queryOk"] = false });
    }

    private static Dictionary<string, object> StatusData(InstanceRuntimeState st, int pid)
    {
        var uptime = st.StartedAt.HasValue ? (int)(DateTime.UtcNow - st.StartedAt.Value).TotalSeconds : 0;
        return new Dictionary<string, object>
        {
            ["state"] = st.State,
            ["pid"] = pid,
            ["port"] = st.Port,
            ["players"] = st.Players,
            ["maxPlayers"] = st.MaxPlayers,
            ["uptimeSec"] = uptime,
            ["queryOk"] = st.QueryOk,
            ["queryError"] = st.QueryError ?? "",
            ["hostname"] = st.QueryHostname,
            ["map"] = st.QueryMap,
            ["password"] = st.QueryPassword,
            ["queryPort"] = st.QueryPort,
            ["queriedAt"] = st.QueriedAt?.ToString("o") ?? "",
            ["adopted"] = st.Adopted,
            ["headless"] = HeadlessStatusList(st),
        };
    }

    private static List<Dictionary<string, object?>> HeadlessStatusList(InstanceRuntimeState st) =>
        st.Headless.Select(h => new Dictionary<string, object?>
        {
            ["name"] = h.Name,
            ["state"] = h.State,
            ["pid"] = h.Pid,
            ["port"] = h.Port,
            ["error"] = h.Error,
        }).ToList();

    public ResultBody ScaleHeadless(InstanceControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.InstanceId))
            return Fail("instanceId required");
        if (!_procs.TryGetValue(p.InstanceId, out var server) || server.HasExited)
            return Fail("dedicated server is not running — start the instance before scaling headless clients");

        var root = string.IsNullOrWhiteSpace(p.ArmaRoot) ? _cfg.ArmaRoot : p.ArmaRoot!;
        var desired = p.Headless ?? new List<HeadlessSpecPayload>();
        var desiredNames = new HashSet<string>(desired.Select(h => h.Name), StringComparer.OrdinalIgnoreCase);

        if (!_states.TryGetValue(p.InstanceId, out var st))
        {
            st = new InstanceRuntimeState { InstanceId = p.InstanceId };
            _states[p.InstanceId] = st;
        }

        // Stop HCs that are no longer desired.
        foreach (var existing in st.Headless.ToArray())
        {
            if (desiredNames.Contains(existing.Name)) continue;
            StopOneHeadless(p.InstanceId, existing.Name);
        }

        StartHeadlessList(p.InstanceId, root, desired, pauseForServer: true);
        RefreshHeadlessStates(p.InstanceId, requireServerQuery: true);
        return Ok("headless scaled", new Dictionary<string, object>
        {
            ["headless"] = HeadlessStatusList(st),
            ["desiredCount"] = desired.Count,
        });
    }

    /// <summary>Scale HC worker group processes (no local dedicated server required).</summary>
    public ResultBody ScaleHcGroup(HcGroupControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.GroupId))
            return Fail("groupId required");
        var groupKey = GroupStateKey(p.GroupId);
        var root = string.IsNullOrWhiteSpace(p.ArmaRoot) ? _cfg.ArmaRoot : p.ArmaRoot!;
        var desired = p.Headless ?? new List<HeadlessSpecPayload>();
        var desiredNames = new HashSet<string>(desired.Select(h => h.Name), StringComparer.OrdinalIgnoreCase);

        if (!_states.TryGetValue(groupKey, out var st))
        {
            st = new InstanceRuntimeState { InstanceId = groupKey };
            _states[groupKey] = st;
        }

        foreach (var existing in st.Headless.ToArray())
        {
            if (desiredNames.Contains(existing.Name)) continue;
            StopOneHeadless(groupKey, existing.Name);
        }

        StartHeadlessList(groupKey, root, desired, pauseForServer: false);
        RefreshHeadlessStates(groupKey, requireServerQuery: false);
        return Ok("hc group scaled", new Dictionary<string, object>
        {
            ["headless"] = HeadlessStatusList(st),
            ["desiredCount"] = desired.Count,
            ["groupId"] = p.GroupId,
        });
    }

    public ResultBody RestartHcGroup(HcGroupControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.GroupId))
            return Fail("groupId required");
        var groupKey = GroupStateKey(p.GroupId);
        var name = string.IsNullOrWhiteSpace(p.Name)
            ? p.Headless?.FirstOrDefault()?.Name
            : p.Name;
        if (string.IsNullOrWhiteSpace(name))
            return Fail("headless name required");
        var root = string.IsNullOrWhiteSpace(p.ArmaRoot) ? _cfg.ArmaRoot : p.ArmaRoot!;
        StopOneHeadless(groupKey, name!);
        var spec = p.Headless?.FirstOrDefault(h =>
            string.Equals(h.Name, name, StringComparison.OrdinalIgnoreCase));
        if (spec == null)
            return Fail($"no launch spec for {name}");
        StartHeadlessList(groupKey, root, new List<HeadlessSpecPayload> { spec }, pauseForServer: false);
        RefreshHeadlessStates(groupKey, requireServerQuery: false);
        var st = _states.GetValueOrDefault(groupKey) ?? new InstanceRuntimeState { InstanceId = groupKey };
        return Ok("hc group member restarted", new Dictionary<string, object> { ["headless"] = HeadlessStatusList(st) });
    }

    public ResultBody StopHcGroup(HcGroupControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.GroupId))
            return Fail("groupId required");
        var groupKey = GroupStateKey(p.GroupId);
        if (!string.IsNullOrWhiteSpace(p.Name))
        {
            StopOneHeadless(groupKey, p.Name!);
        }
        else
        {
            StopAllHeadless(groupKey);
        }
        var st = _states.GetValueOrDefault(groupKey) ?? new InstanceRuntimeState { InstanceId = groupKey };
        return Ok("hc group stopped", new Dictionary<string, object> { ["headless"] = HeadlessStatusList(st) });
    }

    public Dictionary<string, object> HcGroupsHeartbeatSnapshot()
    {
        var map = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in _states)
        {
            if (!kv.Key.StartsWith("g:", StringComparison.Ordinal)) continue;
            var groupId = kv.Key[2..];
            RefreshHeadlessStates(kv.Key, requireServerQuery: false);
            map[groupId] = new Dictionary<string, object?>
            {
                ["headless"] = HeadlessStatusList(kv.Value),
            };
        }
        return map;
    }

    private static string GroupStateKey(string groupId) => "g:" + groupId;

    public ResultBody RestartHeadless(InstanceControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.InstanceId))
            return Fail("instanceId required");
        var name = string.IsNullOrWhiteSpace(p.Name)
            ? p.Headless?.FirstOrDefault()?.Name
            : p.Name;
        if (string.IsNullOrWhiteSpace(name))
            return Fail("headless name required");
        var root = string.IsNullOrWhiteSpace(p.ArmaRoot) ? _cfg.ArmaRoot : p.ArmaRoot!;
        StopOneHeadless(p.InstanceId, name!);
        var spec = p.Headless?.FirstOrDefault(h =>
            string.Equals(h.Name, name, StringComparison.OrdinalIgnoreCase));
        if (spec == null)
            return Fail($"no launch spec for {name}");
        StartHeadlessList(p.InstanceId, root, new List<HeadlessSpecPayload> { spec }, pauseForServer: true);
        RefreshHeadlessStates(p.InstanceId, requireServerQuery: true);
        var st = _states.GetValueOrDefault(p.InstanceId) ?? new InstanceRuntimeState { InstanceId = p.InstanceId };
        return Ok("headless restarted", new Dictionary<string, object> { ["headless"] = HeadlessStatusList(st) });
    }

    public ResultBody StopHeadlessOne(InstanceControlPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.InstanceId))
            return Fail("instanceId required");
        if (string.IsNullOrWhiteSpace(p.Name))
            return Fail("headless name required");
        StopOneHeadless(p.InstanceId, p.Name!);
        var st = _states.GetValueOrDefault(p.InstanceId) ?? new InstanceRuntimeState { InstanceId = p.InstanceId };
        return Ok("headless stopped", new Dictionary<string, object> { ["headless"] = HeadlessStatusList(st) });
    }

    private int StartHeadlessList(string instanceId, string root, List<HeadlessSpecPayload>? specs, bool pauseForServer)
    {
        if (specs == null || specs.Count == 0) return 0;
        if (!_states.TryGetValue(instanceId, out var st))
        {
            st = new InstanceRuntimeState { InstanceId = instanceId };
            _states[instanceId] = st;
        }

        if (pauseForServer)
            Thread.Sleep(2500);

        var exe = ResolveArmaExe(root);
        if (exe == null)
        {
            foreach (var spec in specs)
            {
                UpsertHeadlessState(st, spec, "failed", null, "Arma executable not found");
            }
            return 0;
        }

        var started = 0;
        foreach (var spec in specs)
        {
            var name = string.IsNullOrWhiteSpace(spec.Name) ? "hc0" : spec.Name.Trim();
            var key = HcKey(instanceId, name);
            if (_hcProcs.TryGetValue(key, out var existing) && !existing.HasExited)
            {
                UpsertHeadlessState(st, spec, "running", existing.Id, null);
                started++;
                continue;
            }

            var profileRel = string.IsNullOrWhiteSpace(spec.ProfileDir) ? $"hc/{name}" : spec.ProfileDir!;
            var profilePath = Path.IsPathRooted(profileRel) ? profileRel : Path.Combine(root, profileRel);
            try { Directory.CreateDirectory(profilePath); }
            catch (Exception ex)
            {
                UpsertHeadlessState(st, spec, "failed", null, ex.Message);
                continue;
            }

            var args = (spec.Args ?? Array.Empty<string>()).ToList();
            if (!args.Any(a => a.StartsWith("-profiles=", StringComparison.OrdinalIgnoreCase)))
                args.Add($"-profiles={profilePath}");

            var psi = new ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            try
            {
                var proc = Process.Start(psi) ?? throw new InvalidOperationException("Process.Start returned null");
                _hcProcs[key] = proc;
                UpsertHeadlessState(st, spec, "starting", proc.Id, null, profilePath, args.ToArray());
                TryWriteHcPidFile(st.ProfilePath, name, proc.Id);
                started++;
            }
            catch (Exception ex)
            {
                UpsertHeadlessState(st, spec, "failed", null, ex.Message);
            }
        }
        return started;
    }

    private void StopAllHeadless(string instanceId)
    {
        if (_states.TryGetValue(instanceId, out var st))
        {
            foreach (var hc in st.Headless.ToArray())
                StopOneHeadless(instanceId, hc.Name);
            st.Headless.Clear();
        }
        else
        {
            foreach (var key in _hcProcs.Keys.Where(k => k.StartsWith(instanceId + "/", StringComparison.OrdinalIgnoreCase)).ToArray())
            {
                var name = key[(instanceId.Length + 1)..];
                StopOneHeadless(instanceId, name);
            }
        }
    }

    private void StopOneHeadless(string instanceId, string name)
    {
        var key = HcKey(instanceId, name);
        if (_hcProcs.TryRemove(key, out var proc))
        {
            try
            {
                if (!proc.HasExited)
                {
                    proc.Kill(entireProcessTree: true);
                    proc.WaitForExit(15_000);
                }
            }
            catch { /* ignore */ }
        }

        if (_states.TryGetValue(instanceId, out var st))
        {
            TryDeleteHcPidFile(st.ProfilePath, name);
            var hc = st.Headless.FirstOrDefault(h =>
                string.Equals(h.Name, name, StringComparison.OrdinalIgnoreCase));
            if (hc != null)
            {
                hc.State = "stopped";
                hc.Pid = null;
                hc.Error = null;
                st.Headless.Remove(hc);
            }
        }
    }

    private void RefreshHeadlessStates(string instanceId, bool requireServerQuery)
    {
        if (!_states.TryGetValue(instanceId, out var st)) return;
        var serverOk = requireServerQuery ? st.QueryOk : true;
        foreach (var hc in st.Headless)
        {
            var key = HcKey(instanceId, hc.Name);
            if (_hcProcs.TryGetValue(key, out var proc) && !proc.HasExited)
            {
                hc.Pid = proc.Id;
                var age = hc.StartedAt.HasValue
                    ? (DateTime.UtcNow - hc.StartedAt.Value).TotalSeconds
                    : 0;
                if (serverOk && age >= 12)
                    hc.State = "connected";
                else if (age >= 3)
                    hc.State = "running";
                else
                    hc.State = "starting";
                hc.Error = null;
            }
            else if (hc.State is not ("stopped" or "failed"))
            {
                hc.State = "failed";
                hc.Pid = null;
                hc.Error ??= "process not running";
            }
        }
    }

    private void TryAdoptHeadless(string instanceId, InstanceRuntimeState st)
    {
        if (string.IsNullOrWhiteSpace(st.ProfilePath)) return;
        foreach (var hc in st.Headless.ToArray())
        {
            var pid = TryReadHcPidFile(st.ProfilePath, hc.Name);
            if (pid is not int filePid) continue;
            try
            {
                var proc = Process.GetProcessById(filePid);
                if (proc.HasExited || !IsArmaProcessName(proc.ProcessName)) continue;
                _hcProcs[HcKey(instanceId, hc.Name)] = proc;
                hc.Pid = filePid;
                hc.State = "running";
                hc.Error = null;
            }
            catch { /* stale */ }
        }
    }

    private static void UpsertHeadlessState(
        InstanceRuntimeState st,
        HeadlessSpecPayload spec,
        string state,
        int? pid,
        string? error,
        string? profilePath = null,
        string[]? args = null)
    {
        var name = string.IsNullOrWhiteSpace(spec.Name) ? "hc0" : spec.Name.Trim();
        var hc = st.Headless.FirstOrDefault(h =>
            string.Equals(h.Name, name, StringComparison.OrdinalIgnoreCase));
        if (hc == null)
        {
            hc = new HeadlessRuntimeState { Name = name };
            st.Headless.Add(hc);
        }
        hc.State = state;
        hc.Pid = pid;
        hc.Port = spec.Port;
        hc.Error = error;
        if (profilePath != null) hc.ProfilePath = profilePath;
        if (args != null) hc.Args = args;
        if (state is "starting" or "running" or "connected")
            hc.StartedAt ??= DateTime.UtcNow;
    }

    private static string? ResolveArmaExe(string root)
    {
        var exe64 = Path.Combine(root, "arma3server_x64.exe");
        if (File.Exists(exe64)) return exe64;
        var exe32 = Path.Combine(root, "arma3server.exe");
        return File.Exists(exe32) ? exe32 : null;
    }

    private static string HcPidFilePath(string instanceProfilePath, string name) =>
        Path.Combine(instanceProfilePath, $".a3panel.{name}.pid");

    private static void TryWriteHcPidFile(string instanceProfilePath, string name, int pid)
    {
        if (string.IsNullOrWhiteSpace(instanceProfilePath)) return;
        try
        {
            Directory.CreateDirectory(instanceProfilePath);
            File.WriteAllText(HcPidFilePath(instanceProfilePath, name), pid.ToString());
        }
        catch { /* ignore */ }
    }

    private static int? TryReadHcPidFile(string instanceProfilePath, string name)
    {
        try
        {
            var path = HcPidFilePath(instanceProfilePath, name);
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path).Trim();
            return int.TryParse(text, out var pid) && pid > 0 ? pid : null;
        }
        catch { return null; }
    }

    private static void TryDeleteHcPidFile(string instanceProfilePath, string name)
    {
        try
        {
            var path = HcPidFilePath(instanceProfilePath, name);
            if (File.Exists(path)) File.Delete(path);
        }
        catch { /* ignore */ }
    }

    private static string PidFilePath(string profilePath) =>
        Path.Combine(profilePath, ".a3panel.pid");

    private static void TryWritePidFile(string profilePath, int pid)
    {
        try
        {
            Directory.CreateDirectory(profilePath);
            File.WriteAllText(PidFilePath(profilePath), pid.ToString());
        }
        catch
        {
            /* non-fatal */
        }
    }

    private static int? TryReadPidFile(string profilePath)
    {
        try
        {
            var path = PidFilePath(profilePath);
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path).Trim();
            return int.TryParse(text, out var pid) && pid > 0 ? pid : null;
        }
        catch
        {
            return null;
        }
    }

    private static void TryDeletePidFile(string profilePath)
    {
        try
        {
            var path = PidFilePath(profilePath);
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            /* ignore */
        }
    }

    /// <summary>
    /// Find arma3server processes for this instance via command line (-port / -profiles / -config).
    /// Needed when the agent restarted and lost the Process handle while Arma kept running.
    /// </summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static List<int> FindMatchingArmaPids(string profilePath, int port)
    {
        var profileNorm = "";
        try { profileNorm = Path.GetFullPath(profilePath).TrimEnd('\\', '/'); }
        catch { profileNorm = (profilePath ?? "").TrimEnd('\\', '/'); }
        var configNeedle = string.IsNullOrEmpty(profileNorm) ? "" : Path.Combine(profileNorm, "server.cfg");
        var portNeedle = $"-port={port}";

        return ListArmaProcesses()
            .Where(o =>
            {
                var cmd = o.CommandLine;
                // Never match headless clients when hunting the dedicated server.
                if (cmd.Contains("-client", StringComparison.OrdinalIgnoreCase)) return false;
                if (o.Port == port) return true;
                if (cmd.Contains(portNeedle, StringComparison.OrdinalIgnoreCase)) return true;
                if (!string.IsNullOrEmpty(profileNorm) && cmd.Contains(profileNorm, StringComparison.OrdinalIgnoreCase))
                {
                    // Exclude HC profiles under {profile}/hc/
                    if (cmd.Contains(profileNorm + "\\hc\\", StringComparison.OrdinalIgnoreCase) ||
                        cmd.Contains(profileNorm + "/hc/", StringComparison.OrdinalIgnoreCase))
                        return false;
                    return true;
                }
                if (!string.IsNullOrEmpty(configNeedle) && cmd.Contains(configNeedle, StringComparison.OrdinalIgnoreCase)) return true;
                return false;
            })
            .Select(o => o.Pid)
            .Distinct()
            .ToList();
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static List<ArmaProcessInfo> ListArmaProcesses()
    {
        var list = new List<ArmaProcessInfo>();
        try
        {
            using var searcher = new System.Management.ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'arma3server_x64.exe' OR Name = 'arma3server.exe'");
            foreach (var obj in searcher.Get().Cast<System.Management.ManagementObject>())
            {
                try
                {
                    var pid = Convert.ToInt32(obj["ProcessId"]);
                    var cmd = obj["CommandLine"]?.ToString() ?? "";
                    list.Add(new ArmaProcessInfo
                    {
                        Pid = pid,
                        Port = ParsePortFromCmd(cmd),
                        CommandLine = cmd,
                        ProfileHint = ParseProfilesFromCmd(cmd),
                    });
                }
                catch
                {
                    /* skip row */
                }
            }
        }
        catch
        {
            /* WMI unavailable */
        }
        return list;
    }

    private static int? ParsePortFromCmd(string cmd)
    {
        var m = System.Text.RegularExpressions.Regex.Match(cmd, @"-port=(\d+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return m.Success && int.TryParse(m.Groups[1].Value, out var p) ? p : null;
    }

    private static string? ParseProfilesFromCmd(string cmd)
    {
        var m = System.Text.RegularExpressions.Regex.Match(
            cmd,
            @"-profiles=(?:""([^""]+)""|(\S+))",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        return m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
    }

    private static ResultBody Ok(string message, Dictionary<string, object>? data = null) =>
        new() { Ok = true, Final = true, Message = message, Data = data };

    private static ResultBody Fail(string error) =>
        new() { Ok = false, Final = true, Error = error, Message = error };
}

public sealed class HostBootstrapper
{
    private readonly AgentConfig _cfg;

    public HostBootstrapper(AgentConfig cfg) => _cfg = cfg;

    public ResultBody Prepare(HostBootstrapPayload p)
    {
        var data = new Dictionary<string, object>();
        var steamCmdPath = _cfg.SteamCmdPath;
        var steamCmdExists = File.Exists(steamCmdPath);
        data["steamCmdPath"] = steamCmdPath;
        data["steamCmdPresent"] = steamCmdExists;

        if (p.EnsureSteamCmd && !steamCmdExists)
        {
            // Soft guidance only — auto-download of SteamCMD zip can be added later.
            data["steamCmdHint"] = "SteamCMD not found. Install SteamCMD and set steamCmdPath in agent.json.";
        }

        var root = _cfg.ArmaRoot;
        data["armaRoot"] = root;
        data["armaRootExists"] = Directory.Exists(root);

        if (p.EnsureDirs)
        {
            try
            {
                Directory.CreateDirectory(root);
                Directory.CreateDirectory(Path.Combine(root, "profiles"));
                Directory.CreateDirectory(Path.Combine(root, "mpmissions"));
                Directory.CreateDirectory(Path.Combine(root, "keys"));
                Directory.CreateDirectory(Path.Combine(root, "mods"));
                var lib = ModsLibrary.ResolveLibraryPath(_cfg);
                Directory.CreateDirectory(lib);
                data["modsLibraryPath"] = lib;
                data["dirsCreated"] = true;
            }
            catch (Exception ex)
            {
                return new ResultBody { Ok = false, Final = true, Error = "failed to create dirs: " + ex.Message, Data = data };
            }
        }

        var exe64 = Path.Combine(root, "arma3server_x64.exe");
        var exe32 = Path.Combine(root, "arma3server.exe");
        var armaPresent = File.Exists(exe64) || File.Exists(exe32);
        data["armaServerPresent"] = armaPresent;
        data["armaServerExe"] = File.Exists(exe64) ? exe64 : (File.Exists(exe32) ? exe32 : "");

        var ok = steamCmdExists; // dirs + reporting always useful even if Arma missing
        var msg = armaPresent
            ? (steamCmdExists ? "host prepared" : "folders ready; SteamCMD missing")
            : (steamCmdExists
                ? "SteamCMD ok; Arma server not installed — panel can download creatordlc into armaRoot"
                : "SteamCMD and Arma server missing — install SteamCMD, then Prepare host to download creatordlc");

        return new ResultBody
        {
            Ok = ok || Directory.Exists(root),
            Final = true,
            Message = msg,
            Stage = "bootstrap",
            Data = data,
        };
    }

    public ResultBody Info()
    {
        var prep = Prepare(new HostBootstrapPayload { EnsureSteamCmd = false, EnsureDirs = false });
        prep.Data ??= new Dictionary<string, object>();
        prep.Data["steamcmdRunning"] = false;
        return prep;
    }
}

public static class ConfigApplier
{
    public static ResultBody Apply(AgentConfig cfg, ApplyConfigPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.InstanceId))
            return new ResultBody { Ok = false, Final = true, Error = "instanceId required" };

        var root = cfg.ArmaRoot;
        var profileDir = string.IsNullOrWhiteSpace(p.ProfileDir) ? "profiles" : p.ProfileDir!;
        var baseDir = Path.IsPathRooted(profileDir) ? profileDir : Path.Combine(root, profileDir);
        Directory.CreateDirectory(baseDir);

        var written = new List<string>();
        foreach (var f in p.Files ?? [])
        {
            if (string.IsNullOrWhiteSpace(f.RelativePath)) continue;
            // Prevent path escape
            var combined = Path.GetFullPath(Path.Combine(baseDir, f.RelativePath));
            if (!combined.StartsWith(Path.GetFullPath(baseDir), StringComparison.OrdinalIgnoreCase) &&
                !combined.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase))
            {
                return new ResultBody { Ok = false, Final = true, Error = "invalid relativePath: " + f.RelativePath };
            }
            Directory.CreateDirectory(Path.GetDirectoryName(combined)!);
            try
            {
                WriteAllTextRetry(combined, f.Content ?? "");
            }
            catch (Exception ex)
            {
                return new ResultBody
                {
                    Ok = false,
                    Final = true,
                    Error = $"failed writing {f.RelativePath}: {ex.Message}",
                };
            }
            written.Add(combined);
        }

        return new ResultBody
        {
            Ok = true,
            Final = true,
            Message = $"wrote {written.Count} file(s)",
            Data = new Dictionary<string, object> { ["files"] = written.ToArray() },
        };
    }

    /// <summary>Retry on sharing violations — Arma can hold server.cfg briefly after kill.</summary>
    private static void WriteAllTextRetry(string path, string content, int attempts = 10)
    {
        for (var i = 0; i < attempts; i++)
        {
            try
            {
                File.WriteAllText(path, content);
                return;
            }
            catch (IOException) when (i < attempts - 1)
            {
                Thread.Sleep(300 * (i + 1));
            }
            catch (UnauthorizedAccessException) when (i < attempts - 1)
            {
                Thread.Sleep(300 * (i + 1));
            }
        }
    }
}

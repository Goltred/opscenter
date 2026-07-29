using System.Diagnostics;
using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace OpsCenter.Agent;

public sealed class DownloadModPayload
{
    [JsonPropertyName("workshopId")] public string WorkshopId { get; set; } = "";
    [JsonPropertyName("workshopIds")] public string[]? WorkshopIds { get; set; }
    [JsonPropertyName("steamAccountId")] public string? SteamAccountId { get; set; }
    /// <summary>One-shot credentials from the control plane (preferred). Not written to disk.</summary>
    [JsonPropertyName("username")] public string? Username { get; set; }
    [JsonPropertyName("password")] public string? Password { get; set; }
    [JsonPropertyName("validate")] public bool Validate { get; set; }
    [JsonPropertyName("jobId")] public string? JobId { get; set; }
}

public sealed class UpdateAppPayload
{
    /// <summary>Steam app id. Arma 3 Dedicated Server = 233780.</summary>
    [JsonPropertyName("appId")] public string AppId { get; set; } = "233780";
    [JsonPropertyName("steamAccountId")] public string? SteamAccountId { get; set; }
    [JsonPropertyName("username")] public string? Username { get; set; }
    [JsonPropertyName("password")] public string? Password { get; set; }
    [JsonPropertyName("validate")] public bool Validate { get; set; }
    [JsonPropertyName("beta")] public string? Beta { get; set; }
}

public sealed class SteamCmdRunner
{
    private const string ArmaWorkshopAppId = "107410";
    public const string ArmaDedicatedServerAppId = "233780";
    private readonly AgentConfig _cfg;
    private readonly object _gate = new();
    private Process? _active;
    private string? _activeJobId;
    private CancellationTokenSource? _cts;

    public SteamCmdRunner(AgentConfig cfg) => _cfg = cfg;

    public bool IsRunning
    {
        get { lock (_gate) return _active is { HasExited: false }; }
    }

    public int? Pid
    {
        get { lock (_gate) return _active is { HasExited: false } p ? p.Id : null; }
    }

    public Task<ResultBody> DownloadAsync(
        string jobId,
        DownloadModPayload payload,
        Func<ResultBody, Task> progress,
        CancellationToken outer = default)
    {
        var ids = (payload.WorkshopIds ?? Array.Empty<string>())
            .Concat(string.IsNullOrWhiteSpace(payload.WorkshopId) ? Array.Empty<string>() : new[] { payload.WorkshopId })
            .Select(x => x.Trim())
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        if (ids.Length == 0)
            return Task.FromResult(Fail("no workshop ids provided"));

        var args = new List<string> { "+force_install_dir", _cfg.ArmaRoot, "+login", "", "" };
        foreach (var id in ids)
        {
            args.Add("+workshop_download_item");
            args.Add(ArmaWorkshopAppId);
            args.Add(id);
            if (payload.Validate) args.Add("validate");
        }
        args.Add("+quit");

        var label = ids.Length == 1 ? $"workshop {ids[0]}" : $"{ids.Length} workshop items";
        return RunSteamCmdAsync(jobId, payload.Username, payload.Password, payload.SteamAccountId, args, progress, outer, label);
    }

    public Task<ResultBody> UpdateAppAsync(
        string jobId,
        UpdateAppPayload payload,
        Func<ResultBody, Task> progress,
        CancellationToken outer = default)
    {
        var appId = string.IsNullOrWhiteSpace(payload.AppId) ? ArmaDedicatedServerAppId : payload.AppId.Trim();
        var args = new List<string>
        {
            "+force_install_dir", _cfg.ArmaRoot,
            "+login", "", "",
            "+app_update", appId,
        };
        if (!string.IsNullOrWhiteSpace(payload.Beta))
        {
            args.Add("-beta");
            args.Add(payload.Beta!);
        }
        if (payload.Validate) args.Add("validate");
        args.Add("+quit");

        return RunSteamCmdAsync(jobId, payload.Username, payload.Password, payload.SteamAccountId, args, progress, outer, $"app_update {appId}");
    }

    private async Task<ResultBody> RunSteamCmdAsync(
        string jobId,
        string? username,
        string? password,
        string? steamAccountId,
        List<string> args,
        Func<ResultBody, Task> progress,
        CancellationToken outer,
        string label)
    {
        if (string.IsNullOrWhiteSpace(_cfg.SteamCmdPath) || !File.Exists(_cfg.SteamCmdPath))
            return Fail("steamCmdPath not configured or missing on host");

        string loginUser;
        string loginPass;
        if (!string.IsNullOrWhiteSpace(username))
        {
            loginUser = username!;
            loginPass = password ?? "";
        }
        else
        {
            // Optional local fallback for offline/dev — prefer panel-sent credentials.
            var acctId = string.IsNullOrWhiteSpace(steamAccountId) ? "default" : steamAccountId!;
            if (!_cfg.SteamAccounts.TryGetValue(acctId, out var acct) || string.IsNullOrWhiteSpace(acct.Username))
                return Fail("no Steam credentials in command (configure Admin → Steam on the panel)");
            loginUser = acct.Username;
            loginPass = acct.Password ?? "";
        }

        // Fill login placeholders (positions after +login)
        for (var i = 0; i < args.Count - 2; i++)
        {
            if (args[i] == "+login")
            {
                args[i + 1] = loginUser;
                args[i + 2] = loginPass;
                break;
            }
        }

        lock (_gate)
        {
            if (_active is { HasExited: false })
                return Fail("steamcmd already running");
        }

        async Task<(string output, bool ok)> RunOnce(bool forceValidate, CancellationToken ct)
        {
            var runArgs = new List<string>(args);
            if (forceValidate && !runArgs.Contains("validate"))
                runArgs.Insert(runArgs.Count - 1, "validate");

            var psi = new ProcessStartInfo
            {
                FileName = _cfg.SteamCmdPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in runArgs) psi.ArgumentList.Add(a);

            var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var sb = new StringBuilder();
            var emitLock = new object();
            string? lastEmitted = null;
            async Task EmitLine(string line)
            {
                line = line.TrimEnd();
                if (line.Length == 0) return;
                lock (emitLock)
                {
                    // SteamCMD often mirrors the same line on stdout and stderr.
                    if (string.Equals(line, lastEmitted, StringComparison.Ordinal))
                        return;
                    lastEmitted = line;
                    sb.AppendLine(line);
                }
                await progress(new ResultBody
                {
                    Ok = true,
                    Final = false,
                    Stage = "downloading",
                    Message = "steamcmd: " + line,
                    LogLine = line,
                    Data = new Dictionary<string, object> { ["label"] = label, ["pid"] = proc.Id },
                });
            }

            lock (_gate)
            {
                _active = proc;
                _activeJobId = jobId;
            }

            await progress(new ResultBody
            {
                Ok = true,
                Final = false,
                Stage = "downloading",
                Message = $"starting steamcmd for {label}",
                Data = new Dictionary<string, object> { ["label"] = label, ["pid"] = 0 },
            });

            if (!proc.Start())
                throw new InvalidOperationException("failed to start steamcmd");

            await progress(new ResultBody
            {
                Ok = true,
                Final = false,
                Stage = "downloading",
                Message = $"steamcmd pid {proc.Id}",
                Data = new Dictionary<string, object> { ["label"] = label, ["pid"] = proc.Id },
                LogLine = $"steamcmd pid {proc.Id}",
            });

            var readOut = Task.Run(async () =>
            {
                while (!proc.StandardOutput.EndOfStream)
                {
                    var line = await proc.StandardOutput.ReadLineAsync(ct);
                    if (line is null) break;
                    await EmitLine(line);
                }
            }, ct);

            var readErr = Task.Run(async () =>
            {
                while (!proc.StandardError.EndOfStream)
                {
                    var line = await proc.StandardError.ReadLineAsync(ct);
                    if (line is null) break;
                    await EmitLine(line);
                }
            }, ct);

            try
            {
                await Task.WhenAll(readOut, readErr, proc.WaitForExitAsync(ct));
            }
            catch (OperationCanceledException)
            {
                try { if (!proc.HasExited) proc.Kill(entireProcessTree: true); } catch { /* ignore */ }
                throw;
            }
            finally
            {
                lock (_gate)
                {
                    if (_active == proc)
                    {
                        _active = null;
                        _activeJobId = null;
                    }
                }
            }

            var output = sb.ToString();
            var ok = proc.ExitCode == 0 && !HasSoftFailure(output);
            return (output, ok);
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
        lock (_gate) _cts = linked;

        try
        {
            var (out1, ok1) = await RunOnce(false, linked.Token);
            if (ok1) return Ok($"steamcmd ok: {label}");

            await progress(new ResultBody
            {
                Ok = true,
                Final = false,
                Stage = "downloading",
                Message = "retrying steamcmd with validate for " + label,
                LogLine = "retrying steamcmd with validate for " + label,
            });

            var (out2, ok2) = await RunOnce(true, linked.Token);
            if (ok2) return Ok($"steamcmd ok: {label}");

            var failedIds = ExtractFailedWorkshopIds(out2);
            var hint = ExplainFailure(out2);
            var summary = failedIds.Count > 0
                ? $"SteamCMD failed for {failedIds.Count} workshop item(s): {string.Join(", ", failedIds)}"
                : $"SteamCMD failed for {label}";

            await progress(new ResultBody
            {
                Ok = false,
                Final = false,
                Stage = "downloading",
                Message = summary,
                LogLine = summary + (string.IsNullOrWhiteSpace(hint) ? "" : " — " + hint),
                Data = new Dictionary<string, object>
                {
                    ["failedWorkshopIds"] = failedIds.ToArray(),
                    ["hint"] = hint,
                },
            });

            return new ResultBody
            {
                Ok = false,
                Final = true,
                Stage = "failed",
                Error = summary,
                Message = hint,
                Data = new Dictionary<string, object>
                {
                    ["failedWorkshopIds"] = failedIds.ToArray(),
                    ["hint"] = hint,
                },
            };
        }
        catch (OperationCanceledException)
        {
            return Fail("steamcmd cancelled");
        }
        catch (Exception ex)
        {
            return Fail("steamcmd failed: " + ex.Message);
        }
        finally
        {
            lock (_gate) _cts = null;
        }
    }

    public ResultBody Cancel(string? jobId)
    {
        lock (_gate)
        {
            if (_active is null || _active.HasExited)
                return Ok("no active steamcmd");
            if (!string.IsNullOrEmpty(jobId) && _activeJobId != null && jobId != _activeJobId)
                return Fail("job id mismatch");
            try
            {
                _cts?.Cancel();
                if (!_active.HasExited) _active.Kill(entireProcessTree: true);
            }
            catch (Exception ex)
            {
                return Fail("kill failed: " + ex.Message);
            }
            return Ok("steamcmd killed");
        }
    }

    private static bool HasSoftFailure(string output)
    {
        var l = output.ToLowerInvariant();
        if (l.Contains("failed (failure)")) return true;
        if (l.Contains("download item") && l.Contains("failed")) return true;
        string[] markers =
        [
            "timeout downloading item",
            "failed to install",
            "login failure",
            "invalid password",
            "rate limit exceeded",
            "missing decryption key",
            "not logged on",
        ];
        return markers.Any(m => l.Contains(m));
    }

    private static List<string> ExtractFailedWorkshopIds(string output)
    {
        var ids = new List<string>();
        // "Downloading item 3712486272 ... ERROR! Download item 3712486272 failed"
        foreach (Match m in Regex.Matches(output, @"Download item\s+(\d+)\s+failed", RegexOptions.IgnoreCase))
        {
            var id = m.Groups[1].Value;
            if (!ids.Contains(id)) ids.Add(id);
        }
        if (ids.Count == 0)
        {
            foreach (Match m in Regex.Matches(output, @"Downloading item\s+(\d+)[^\n]*failed", RegexOptions.IgnoreCase))
            {
                var id = m.Groups[1].Value;
                if (!ids.Contains(id)) ids.Add(id);
            }
        }
        return ids;
    }

    private static string ExplainFailure(string output)
    {
        var l = output.ToLowerInvariant();
        if (l.Contains("missing decryption key"))
            return "Steam account must own Arma 3 (app 107410), not only the dedicated server.";
        if (l.Contains("failed (failure)") || (l.Contains("download item") && l.Contains("failed")))
            return "Usual causes: Steam account does not own Arma 3 client; corrupt workshop download cache (delete steamapps/workshop/downloads under SteamCMD or armaRoot and retry); or the workshop item is removed/private.";
        if (l.Contains("rate limit"))
            return "Steam rate-limited this account — wait and retry.";
        if (l.Contains("invalid password") || l.Contains("login failure"))
            return "Steam login failed — check Admin → Steam username/password (and Steam Guard on the host).";
        return "Workshop downloads need a Steam account that owns Arma 3. Check the SteamCMD panel log for details.";
    }

    private static ResultBody Ok(string message) => new() { Ok = true, Final = true, Stage = "done", Message = message };
    private static ResultBody Fail(string error) => new() { Ok = false, Final = true, Stage = "failed", Error = error, Message = error };
}

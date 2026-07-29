using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace OpsCenter.Agent;

public sealed class DlcCheckPayload
{
    /// <summary>Creator DLC short codes (vn, ws, gm, …).</summary>
    [JsonPropertyName("codes")] public string[]? Codes { get; set; }
    [JsonPropertyName("armaRoot")] public string? ArmaRoot { get; set; }
}

/// <summary>
/// Detect whether armaRoot is on the Steam creatordlc branch and which CDLC folders exist.
/// </summary>
public static class DlcCheck
{
    private const string DedicatedServerAppId = "233780";

    public static ResultBody Check(AgentConfig cfg, DlcCheckPayload payload)
    {
        var root = string.IsNullOrWhiteSpace(payload.ArmaRoot) ? cfg.ArmaRoot : payload.ArmaRoot!.Trim();
        if (string.IsNullOrWhiteSpace(root))
            return Fail("armaRoot not configured");

        var codes = (payload.Codes ?? Array.Empty<string>())
            .Select(c => c.Trim().ToLowerInvariant())
            .Where(c => c.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        var present = new List<string>();
        var missing = new List<string>();
        foreach (var code in codes)
        {
            var dir = Path.Combine(root, code);
            if (Directory.Exists(dir) && Directory.EnumerateFileSystemEntries(dir).Any())
                present.Add(code);
            else
                missing.Add(code);
        }

        var exe64 = Path.Combine(root, "arma3server_x64.exe");
        var exe32 = Path.Combine(root, "arma3server.exe");
        var armaPresent = File.Exists(exe64) || File.Exists(exe32);
        var armaExe = File.Exists(exe64) ? exe64 : (File.Exists(exe32) ? exe32 : "");

        var beta = ReadInstalledBeta(root, DedicatedServerAppId);
        var onCreatorBranch = string.Equals(beta, "creatordlc", StringComparison.OrdinalIgnoreCase);

        string message;
        if (!armaPresent)
            message = "Arma dedicated server not installed under armaRoot";
        else if (onCreatorBranch)
            message = missing.Count == 0
                ? "creatordlc branch; all requested CDLC folders present"
                : $"creatordlc branch; missing folders: {string.Join(", ", missing)}";
        else if (string.IsNullOrEmpty(beta))
            message = "dedicated server installed; branch unknown";
        else
            message = $"dedicated server branch: {beta}";

        return new ResultBody
        {
            Ok = true,
            Final = true,
            Stage = "done",
            Message = message,
            Data = new Dictionary<string, object>
            {
                ["armaRoot"] = root,
                ["armaServerPresent"] = armaPresent,
                ["armaServerExe"] = armaExe,
                ["beta"] = beta ?? "",
                ["onCreatorBranch"] = onCreatorBranch,
                ["present"] = present.ToArray(),
                ["missing"] = missing.ToArray(),
            },
        };
    }

    /// <summary>
    /// Reads BetaKey / betakey from steamapps/appmanifest_233780.acf under armaRoot.
    /// </summary>
    public static string? ReadInstalledBeta(string armaRoot, string appId)
    {
        var acf = Path.Combine(armaRoot, "steamapps", $"appmanifest_{appId}.acf");
        if (!File.Exists(acf)) return null;
        try
        {
            var text = File.ReadAllText(acf);
            // Prefer UserConfig betakey (branch the install is pinned to).
            var m = Regex.Match(
                text,
                "\"UserConfig\"\\s*\\{[^}]*\"betakey\"\\s*\"([^\"]*)\"",
                RegexOptions.IgnoreCase | RegexOptions.Singleline);
            if (m.Success)
            {
                var v = m.Groups[1].Value.Trim();
                return v.Length > 0 ? v : null;
            }
            m = Regex.Match(text, "\"betakey\"\\s*\"([^\"]+)\"", RegexOptions.IgnoreCase);
            if (m.Success)
            {
                var v = m.Groups[1].Value.Trim();
                return v.Length > 0 ? v : null;
            }
        }
        catch
        {
            /* ignore */
        }
        return null;
    }

    private static ResultBody Fail(string error) =>
        new() { Ok = false, Final = true, Stage = "failed", Error = error, Message = error };
}

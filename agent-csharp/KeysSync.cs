using System.Text.Json.Serialization;

namespace OpsCenter.Agent;

public sealed class KeysSyncPayload
{
    /// <summary>Workshop IDs whose .bikey files should be copied into armaRoot\keys\.</summary>
    [JsonPropertyName("workshopIds")] public string[]? WorkshopIds { get; set; }
    /// <summary>
    /// Absolute or armaRoot-relative mod folders already resolved for launch (-mod= paths).
    /// Scanned in addition to workshop-id index so !Workshop / junction mismatches still get keys.
    /// </summary>
    [JsonPropertyName("modPaths")] public string[]? ModPaths { get; set; }
    [JsonPropertyName("libraryPath")] public string? LibraryPath { get; set; }
}

/// <summary>
/// Copy .bikey files from loaded mods into the dedicated server keys folder.
/// Required when verifySignatures is enabled so clients can join with signed content.
/// </summary>
public static class KeysSync
{
    public static ResultBody Sync(AgentConfig cfg, KeysSyncPayload p)
    {
        var ids = (p.WorkshopIds ?? Array.Empty<string>())
            .Select(x => (x ?? "").Trim())
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        var arma = Path.GetFullPath(cfg.ArmaRoot);
        var keysDir = Path.Combine(arma, "keys");
        try { Directory.CreateDirectory(keysDir); }
        catch (Exception ex)
        {
            return Fail($"cannot create keys folder '{keysDir}': {ex.Message}");
        }

        var explicitPaths = (p.ModPaths ?? Array.Empty<string>())
            .Select(x => ResolveModPath(arma, x))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (ids.Length == 0 && explicitPaths.Count == 0)
        {
            return new ResultBody
            {
                Ok = true,
                Final = true,
                Message = "no workshop mods — nothing to sync",
                Data = new Dictionary<string, object>
                {
                    ["keysPath"] = keysDir,
                    ["copied"] = Array.Empty<string>(),
                    ["copiedCount"] = 0,
                    ["unchangedCount"] = 0,
                    ["modsWithoutKeys"] = Array.Empty<string>(),
                    ["missingMods"] = Array.Empty<string>(),
                },
            };
        }

        string library;
        try { library = ModsLibrary.ResolveLibraryPath(cfg, p.LibraryPath); }
        catch (Exception ex) { return Fail("invalid library path: " + ex.Message); }

        var index = ModsLibrary.BuildIdIndex(cfg, library);
        var workshop = ModsLibrary.DefaultWorkshopPath(cfg);

        var copied = new List<string>();
        var unchanged = new List<string>();
        var modsWithoutKeys = new List<string>();
        var missingMods = new List<string>();
        var errors = new List<string>();
        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var scannedDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void HarvestDir(string abs)
        {
            if (string.IsNullOrWhiteSpace(abs)) return;
            string full;
            try { full = Path.GetFullPath(abs); }
            catch { return; }
            if (!scannedDirs.Add(full)) return;
            if (!Directory.Exists(full)) return;

            List<string> bikeys;
            try
            {
                bikeys = Directory.EnumerateFiles(full, "*.bikey", SearchOption.AllDirectories).ToList();
            }
            catch (Exception ex)
            {
                errors.Add($"{full}: {ex.Message}");
                return;
            }

            foreach (var src in bikeys)
            {
                var name = Path.GetFileName(src);
                if (string.IsNullOrWhiteSpace(name)) continue;
                var dest = Path.Combine(keysDir, name);
                try
                {
                    var needCopy = !File.Exists(dest)
                        || new FileInfo(src).Length != new FileInfo(dest).Length
                        || File.GetLastWriteTimeUtc(src) > File.GetLastWriteTimeUtc(dest);
                    if (needCopy)
                    {
                        File.Copy(src, dest, overwrite: true);
                        if (seenNames.Add(name))
                            copied.Add(name);
                    }
                    else if (seenNames.Add(name))
                    {
                        unchanged.Add(name);
                    }
                }
                catch (Exception ex)
                {
                    errors.Add($"{name}: {ex.Message}");
                }
            }
        }

        // Always harvest explicit launch folders first (same trees the server loads).
        foreach (var path in explicitPaths)
            HarvestDir(path!);

        foreach (var id in ids)
        {
            var candidates = new List<string>();
            void AddCandidate(string? dir)
            {
                if (string.IsNullOrWhiteSpace(dir)) return;
                try
                {
                    var full = Path.GetFullPath(dir);
                    if (!candidates.Any(c => string.Equals(c, full, StringComparison.OrdinalIgnoreCase)))
                        candidates.Add(full);
                }
                catch
                {
                    /* ignore */
                }
            }

            if (index.TryGetValue(id, out var found))
                AddCandidate(found);
            AddCandidate(Path.Combine(workshop, id));
            AddCandidate(Path.Combine(library, id));
            // Shared !Workshop @folders that mention this id (publishedid / junction / name suffix).
            AddCandidate(ModsLibrary.FindLibraryFolderForId(library, id));

            var present = candidates.Where(ModsLibrary.IsModPresent).ToList();
            if (present.Count == 0)
            {
                missingMods.Add(id);
                continue;
            }

            // Prefer folders that actually contain .bikey files (avoids empty local stubs shadowing shared).
            var withKeys = present.Where(HasAnyBikey).ToList();
            if (withKeys.Count == 0)
            {
                modsWithoutKeys.Add(id);
                // Still scan present dirs in case keys appear later / partial trees.
                foreach (var dir in present)
                    HarvestDir(dir);
                continue;
            }

            foreach (var dir in withKeys)
                HarvestDir(dir);
        }

        var msg =
            $"Synced {copied.Count} key(s) into keys\\ ({unchanged.Count} already up to date" +
            (modsWithoutKeys.Count > 0 ? $", {modsWithoutKeys.Count} mod(s) had no .bikey" : "") +
            (missingMods.Count > 0 ? $", {missingMods.Count} mod folder(s) missing" : "") +
            ")";

        return new ResultBody
        {
            Ok = true,
            Final = true,
            Message = msg,
            Error = errors.Count > 0 ? string.Join("; ", errors.Take(5)) : null,
            Data = new Dictionary<string, object>
            {
                ["keysPath"] = keysDir,
                ["copied"] = copied.ToArray(),
                ["copiedCount"] = copied.Count,
                ["unchanged"] = unchanged.ToArray(),
                ["unchangedCount"] = unchanged.Count,
                ["modsWithoutKeys"] = modsWithoutKeys.ToArray(),
                ["missingMods"] = missingMods.ToArray(),
                ["errors"] = errors.ToArray(),
                ["scannedDirCount"] = scannedDirs.Count,
            },
        };
    }

    private static bool HasAnyBikey(string dir)
    {
        try
        {
            return Directory.EnumerateFiles(dir, "*.bikey", SearchOption.AllDirectories).Any();
        }
        catch
        {
            return false;
        }
    }

    private static string? ResolveModPath(string armaRoot, string? raw)
    {
        var s = (raw ?? "").Trim();
        if (s.Length == 0) return null;
        // Strip -mod= prefix if a full arg was passed by mistake.
        if (s.StartsWith("-mod=", StringComparison.OrdinalIgnoreCase))
            s = s[5..];
        try
        {
            if (Path.IsPathRooted(s))
                return Path.GetFullPath(s);
            return Path.GetFullPath(Path.Combine(armaRoot, s));
        }
        catch
        {
            return null;
        }
    }

    private static ResultBody Fail(string error) =>
        new() { Ok = false, Final = true, Error = error, Message = error };
}

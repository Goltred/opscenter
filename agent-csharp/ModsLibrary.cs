using System.Diagnostics;
using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace A3Panel.Agent;

public sealed class ModCheckPayload
{
    [JsonPropertyName("workshopIds")] public string[]? WorkshopIds { get; set; }
    /// <summary>Absolute shared library path from the panel (read-only). Falls back to agent config.</summary>
    [JsonPropertyName("libraryPath")] public string? LibraryPath { get; set; }
    /// <summary>
    /// When true and library is outside the local workshop tree, create junctions under
    /// armaRoot\mods\ pointing at shared folders (shared folder is never written).
    /// </summary>
    [JsonPropertyName("ensureLocalLinks")] public bool EnsureLocalLinks { get; set; }
}

public static class ModsLibrary
{
    private static readonly Regex PublishedIdRe = new(
        @"published\s*id\s*=\s*""?(\d+)""?\s*;?",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex WorkshopContentIdRe = new(
        @"[\\/](?:steamapps[\\/])?workshop[\\/]content[\\/]107410[\\/](\d+)(?:[\\/]|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    public static string DefaultWorkshopPath(AgentConfig cfg) =>
        Path.GetFullPath(Path.Combine(cfg.ArmaRoot, "steamapps", "workshop", "content", "107410"));

    public static string ResolveLibraryPath(AgentConfig cfg, string? overridePath = null)
    {
        var o = (overridePath ?? "").Trim();
        if (!string.IsNullOrEmpty(o))
            return Path.GetFullPath(o.TrimEnd('\\', '/'));

        var configured = (cfg.ModsLibraryPath ?? "").Trim();
        if (!string.IsNullOrEmpty(configured))
        {
            if (Path.IsPathRooted(configured))
                return Path.GetFullPath(configured.TrimEnd('\\', '/'));
            return Path.GetFullPath(Path.Combine(cfg.ArmaRoot, configured));
        }

        return DefaultWorkshopPath(cfg);
    }

    public static bool IsModPresent(string modDir)
    {
        if (!Directory.Exists(modDir)) return false;
        try
        {
            if (File.Exists(Path.Combine(modDir, "mod.cpp")) || File.Exists(Path.Combine(modDir, "meta.cpp")))
                return true;
            if (Directory.EnumerateFiles(modDir, "*.pbo", SearchOption.AllDirectories).Any())
                return true;
            // Keys-only / partial trees still count if they have signatures to copy.
            if (Directory.EnumerateFiles(modDir, "*.bikey", SearchOption.AllDirectories).Any())
                return true;
            return false;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Rough richness score so empty SteamCMD stubs don't beat a full shared copy.</summary>
    public static int ModContentScore(string modDir)
    {
        if (!Directory.Exists(modDir)) return 0;
        var score = 0;
        try
        {
            if (File.Exists(Path.Combine(modDir, "meta.cpp")) || File.Exists(Path.Combine(modDir, "mod.cpp")))
                score += 1;
            if (Directory.EnumerateFiles(modDir, "*.pbo", SearchOption.AllDirectories).Any())
                score += 10;
            if (Directory.EnumerateFiles(modDir, "*.bikey", SearchOption.AllDirectories).Any())
                score += 5;
        }
        catch
        {
            /* ignore */
        }
        return score;
    }

    public static string? ReadPublishedId(string modDir)
    {
        foreach (var fileName in new[] { "meta.cpp", "mod.cpp" })
        {
            var path = Path.Combine(modDir, fileName);
            if (!File.Exists(path)) continue;
            try
            {
                var text = ReadTextFlexible(path);
                var m = PublishedIdRe.Match(text);
                if (!m.Success) continue;
                var id = m.Groups[1].Value;
                // Steam often writes publishedid = 0 for private / unlinked @folders — ignore.
                if (id == "0") continue;
                return id;
            }
            catch
            {
                /* try next */
            }
        }
        return null;
    }

    /// <summary>
    /// Resolve workshop id from a Steam !Workshop junction/symlink target
    /// (…\steamapps\workshop\content\107410\{id}\).
    /// </summary>
    public static string? ResolveWorkshopIdFromReparseTarget(string modDir)
    {
        try
        {
            var full = Path.GetFullPath(modDir);
            var m = WorkshopContentIdRe.Match(full);
            if (m.Success) return m.Groups[1].Value;

            // .NET resolves junctions/symlinks even when Attributes is unreliable.
            try
            {
                var linked = Directory.ResolveLinkTarget(full, returnFinalTarget: true);
                if (linked != null)
                {
                    m = WorkshopContentIdRe.Match(linked.FullName);
                    if (m.Success) return m.Groups[1].Value;
                }
            }
            catch
            {
                /* fall through */
            }

            var di = new DirectoryInfo(full);
            if (di.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                var target = GetReparseTarget(full);
                if (!string.IsNullOrEmpty(target))
                {
                    m = WorkshopContentIdRe.Match(target);
                    if (m.Success) return m.Groups[1].Value;
                }
            }
        }
        catch
        {
            /* ignore */
        }
        return null;
    }

    /// <summary>
    /// Find a shared-library child folder for a workshop id (@Name with publishedid / junction, or numeric).
    /// </summary>
    public static string? FindLibraryFolderForId(string libraryPath, string workshopId)
    {
        if (string.IsNullOrWhiteSpace(libraryPath) || string.IsNullOrWhiteSpace(workshopId))
            return null;
        if (!Directory.Exists(libraryPath)) return null;

        var direct = Path.Combine(libraryPath, workshopId);
        if (IsModPresent(direct)) return Path.GetFullPath(direct);

        try
        {
            foreach (var d in Directory.EnumerateDirectories(libraryPath))
            {
                foreach (var id in CollectWorkshopIdsForDir(d))
                {
                    if (string.Equals(id, workshopId, StringComparison.Ordinal))
                        return Path.GetFullPath(d);
                }
            }
        }
        catch
        {
            /* ignore */
        }
        return null;
    }

    /// <summary>All workshop IDs we can associate with this mod folder.</summary>
    public static IEnumerable<string> CollectWorkshopIdsForDir(string dir)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(string? id)
        {
            if (string.IsNullOrWhiteSpace(id) || id == "0") return;
            if (!ulong.TryParse(id, out _)) return;
            seen.Add(id);
        }

        Add(ReadPublishedId(dir));
        Add(ResolveWorkshopIdFromReparseTarget(dir));

        var name = Path.GetFileName(dir.TrimEnd('\\', '/'));
        if (ulong.TryParse(name, out _)) Add(name);
        if (!string.IsNullOrEmpty(name))
        {
            var parts = name.Split(new[] { '_', '-', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            var last = parts.Length > 0 ? parts[^1] : "";
            if (ulong.TryParse(last, out _)) Add(last);
        }

        return seen;
    }

    /// <summary>
    /// Map workshop id → absolute mod folder.
    /// Preference: local Steam workshop (writable by SteamCMD) → armaRoot\mods → armaRoot\@* → shared library (read-only).
    /// Shared library is never written by the agent.
    /// </summary>
    public static Dictionary<string, string> BuildIdIndex(AgentConfig cfg, string libraryPath)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var arma = Path.GetFullPath(cfg.ArmaRoot);
        var workshop = DefaultWorkshopPath(cfg);

        void Register(string id, string dir, bool overwrite)
        {
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(dir)) return;
            var full = Path.GetFullPath(dir);
            if (!map.TryGetValue(id, out var existing))
            {
                map[id] = full;
                return;
            }
            var newScore = ModContentScore(full);
            var oldScore = ModContentScore(existing);
            // Prefer richer content (shared full mod beats empty local SteamCMD stub).
            if (newScore > oldScore || (overwrite && newScore == oldScore))
                map[id] = full;
        }

        void Consider(string dir, bool overwrite)
        {
            if (!IsModPresent(dir)) return;
            foreach (var id in CollectWorkshopIdsForDir(dir))
                Register(id, dir, overwrite);
        }

        void ScanChildren(string root, bool atPrefixOnly, bool overwrite)
        {
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return;
            try
            {
                foreach (var d in Directory.EnumerateDirectories(root))
                {
                    var name = Path.GetFileName(d);
                    if (atPrefixOnly && !name.StartsWith("@", StringComparison.Ordinal))
                        continue;
                    Consider(d, overwrite);
                }
            }
            catch
            {
                /* ignore */
            }
        }

        // 1) Local workshop — SteamCMD install target (preferred for launch when present)
        ScanChildren(workshop, atPrefixOnly: false, overwrite: true);

        // 2) Local mods / @ junctions under arma root
        var modsDir = Path.Combine(arma, "mods");
        ScanChildren(modsDir, atPrefixOnly: false, overwrite: false);
        ScanChildren(arma, atPrefixOnly: true, overwrite: false);

        // 3) Shared library (read-only) — fills gaps only
        ScanChildren(libraryPath, atPrefixOnly: false, overwrite: false);

        return map;
    }

    /// <summary>
    /// Create armaRoot\mods\{name} → shared folder junctions for mods that exist only on the shared library.
    /// Never writes inside the shared library.
    /// </summary>
    public static List<string> EnsureLocalJunctions(AgentConfig cfg, string libraryPath, IEnumerable<string> workshopIds)
    {
        var created = new List<string>();
        var arma = Path.GetFullPath(cfg.ArmaRoot);
        var workshop = DefaultWorkshopPath(cfg);
        if (SamePath(libraryPath, workshop))
            return created; // shared == local workshop; nothing to link

        var modsDir = Path.Combine(arma, "mods");
        try { Directory.CreateDirectory(modsDir); }
        catch { return created; }

        // Index only the shared library (source of truth for names)
        var sharedOnly = new Dictionary<string, string>(StringComparer.Ordinal);
        void ConsiderShared(string dir)
        {
            if (!IsModPresent(dir)) return;
            var full = Path.GetFullPath(dir);
            foreach (var id in CollectWorkshopIdsForDir(dir))
            {
                if (!sharedOnly.ContainsKey(id))
                    sharedOnly[id] = full;
            }
        }

        if (Directory.Exists(libraryPath))
        {
            try
            {
                foreach (var d in Directory.EnumerateDirectories(libraryPath))
                    ConsiderShared(d);
            }
            catch { /* ignore */ }
        }

        foreach (var id in workshopIds.Distinct(StringComparer.Ordinal))
        {
            if (!sharedOnly.TryGetValue(id, out var sharedDir)) continue;

            // Prefer leaving local workshop content alone if SteamCMD already has it
            var localWs = Path.Combine(workshop, id);
            if (IsModPresent(localWs)) continue;

            var linkName = Path.GetFileName(sharedDir.TrimEnd('\\', '/'));
            if (string.IsNullOrWhiteSpace(linkName)) linkName = id;
            var dest = Path.Combine(modsDir, linkName);

            if (Directory.Exists(dest) || File.Exists(dest))
                continue;

            if (TryCreateJunction(dest, sharedDir))
                created.Add($"{linkName} → {sharedDir}");
        }

        return created;
    }

    public static string ToLaunchPath(AgentConfig cfg, string absoluteModDir)
    {
        var arma = Path.GetFullPath(cfg.ArmaRoot);
        var full = Path.GetFullPath(absoluteModDir);
        var prefix = arma.TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
        if (full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            return full.Substring(arma.Length).TrimStart('\\', '/');
        return full;
    }

    public static ResultBody Check(AgentConfig cfg, ModCheckPayload p)
    {
        var ids = (p.WorkshopIds ?? Array.Empty<string>())
            .Select(x => (x ?? "").Trim())
            .Where(x => x.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (ids.Length == 0)
            return Fail("no workshop ids provided");

        string library;
        try { library = ResolveLibraryPath(cfg, p.LibraryPath); }
        catch (Exception ex) { return Fail("invalid library path: " + ex.Message); }

        var libExists = Directory.Exists(library);
        var childNames = new List<string>();
        var childCount = 0;
        var unmatchedFolders = new List<string>();
        if (libExists)
        {
            try
            {
                foreach (var d in Directory.EnumerateDirectories(library))
                {
                    childCount++;
                    if (childNames.Count < 8)
                        childNames.Add(Path.GetFileName(d));
                    if (!CollectWorkshopIdsForDir(d).Any())
                    {
                        if (unmatchedFolders.Count < 6)
                            unmatchedFolders.Add(Path.GetFileName(d));
                    }
                }
            }
            catch (Exception ex)
            {
                return Fail($"cannot list library '{library}': {ex.Message}");
            }
        }

        var scanNote = !libExists
            ? $"Library path does not exist on disk: {library}"
            : childCount == 0
                ? $"Library exists but has 0 subfolders: {library}"
                : $"Library has {childCount} folder(s); sample: {string.Join(", ", childNames)}";

        var linked = new List<string>();
        if (p.EnsureLocalLinks)
            linked = EnsureLocalJunctions(cfg, library, ids);

        var index = BuildIdIndex(cfg, library);
        var present = new List<string>();
        var missing = new List<string>();
        var paths = new Dictionary<string, string>(StringComparer.Ordinal);
        var sources = new Dictionary<string, string>(StringComparer.Ordinal);
        var workshop = DefaultWorkshopPath(cfg);
        var missingHints = new List<string>();

        foreach (var id in ids)
        {
            string? abs = null;
            if (index.TryGetValue(id, out var found) && IsModPresent(found))
                abs = found;
            else
            {
                var directLib = Path.Combine(library, id);
                var directWs = Path.Combine(workshop, id);
                if (IsModPresent(directWs)) abs = directWs;
                else if (IsModPresent(directLib)) abs = directLib;
            }

            if (abs != null)
            {
                present.Add(id);
                paths[id] = ToLaunchPath(cfg, abs);
                sources[id] = PathUnder(abs, workshop) ? "local-workshop"
                    : PathUnder(abs, library) ? "shared-library"
                    : "local";
            }
            else
            {
                missing.Add(id);
                missingHints.Add(DescribeMissingHint(library, id));
            }
        }

        if (missing.Count > 0)
        {
            scanNote += $"; indexed {index.Count} workshop id(s) from folders";
            if (unmatchedFolders.Count > 0)
            {
                scanNote +=
                    $"; {unmatchedFolders.Count}+ library folder(s) have no usable publishedid / workshop path " +
                    $"(often publishedid=0 on Steam !Workshop) e.g. {string.Join(", ", unmatchedFolders)}";
            }
            var hintLines = missingHints.Where(h => !string.IsNullOrWhiteSpace(h)).Take(8).ToList();
            if (hintLines.Count > 0)
                scanNote += "; " + string.Join("; ", hintLines);
        }

        return new ResultBody
        {
            Ok = true,
            Final = true,
            Message = $"{present.Count} present, {missing.Count} missing" +
                      (linked.Count > 0 ? $"; linked {linked.Count} into mods\\" : ""),
            Data = new Dictionary<string, object>
            {
                ["libraryPath"] = library,
                ["workshopPath"] = workshop,
                ["libraryReadOnly"] = !SamePath(library, workshop),
                ["libraryExists"] = libExists,
                ["libraryFolderCount"] = childCount,
                ["scanNote"] = scanNote,
                ["present"] = present.ToArray(),
                ["missing"] = missing.ToArray(),
                ["missingHints"] = missingHints.ToArray(),
                ["paths"] = paths,
                ["sources"] = sources,
                ["linksCreated"] = linked.ToArray(),
            },
        };
    }

    private static string DescribeMissingHint(string library, string id)
    {
        if (!Directory.Exists(library)) return $"{id}: library missing";
        try
        {
            foreach (var d in Directory.EnumerateDirectories(library))
            {
                var name = Path.GetFileName(d);
                var pub = ReadPublishedId(d);
                var viaLink = ResolveWorkshopIdFromReparseTarget(d);
                if (name.Contains(id, StringComparison.Ordinal))
                    return $"{id}: folder '{name}' exists but publishedid is '{pub ?? "none"}' (link id '{viaLink ?? "none"}') — not indexed";
            }
        }
        catch { /* ignore */ }

        return $"{id}: not found under library (need meta.cpp publishedid={id}, numeric folder, or !Workshop junction → workshop\\content\\107410\\{id})";
    }

    private static string ReadTextFlexible(string path)
    {
        var bytes = File.ReadAllBytes(path);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
            return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        // UTF-16 LE without BOM heuristic: many NULs in odd positions
        if (bytes.Length > 4 && bytes[1] == 0 && bytes[3] == 0)
            return Encoding.Unicode.GetString(bytes);
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>Best-effort resolve of a directory junction / symlink target on Windows.</summary>
    private static string? GetReparseTarget(string path)
    {
        try
        {
            var di = new DirectoryInfo(path);
            var link = di.LinkTarget;
            if (!string.IsNullOrEmpty(link))
            {
                if (!Path.IsPathRooted(link))
                    link = Path.GetFullPath(Path.Combine(path, link));
                return Path.GetFullPath(link);
            }
        }
        catch
        {
            /* ignore */
        }
        return null;
    }

    private static bool PathUnder(string path, string root)
    {
        try
        {
            var p = Path.GetFullPath(path);
            var r = Path.GetFullPath(root).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            return p.StartsWith(r, StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(Path.GetFullPath(path).TrimEnd('\\', '/'), Path.GetFullPath(root).TrimEnd('\\', '/'),
                       StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static bool TryCreateJunction(string linkPath, string targetPath)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c mklink /J \"{linkPath}\" \"{targetPath}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return false;
            proc.WaitForExit(15_000);
            return proc.ExitCode == 0 && Directory.Exists(linkPath);
        }
        catch
        {
            return false;
        }
    }

    private static bool SamePath(string a, string b)
    {
        try
        {
            return string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static ResultBody Fail(string error) =>
        new() { Ok = false, Final = true, Error = error, Message = error };
}

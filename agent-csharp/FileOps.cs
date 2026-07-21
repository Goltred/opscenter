using System.Text;
using System.Text.Json.Serialization;

namespace A3Panel.Agent;

public sealed class FileListPayload
{
    [JsonPropertyName("relativePath")] public string RelativePath { get; set; } = "";
    [JsonPropertyName("root")] public string Root { get; set; } = "arma";
    /// <summary>Optional absolute override when root is modsLibrary.</summary>
    [JsonPropertyName("libraryPath")] public string? LibraryPath { get; set; }
}

public sealed class FileReadPayload
{
    [JsonPropertyName("relativePath")] public string RelativePath { get; set; } = "";
    [JsonPropertyName("root")] public string Root { get; set; } = "arma";
    [JsonPropertyName("maxBytes")] public int MaxBytes { get; set; }
    [JsonPropertyName("libraryPath")] public string? LibraryPath { get; set; }
}

public sealed class FileDeployPayload
{
    [JsonPropertyName("relativePath")] public string RelativePath { get; set; } = "";
    [JsonPropertyName("contentBase64")] public string? ContentBase64 { get; set; }
    [JsonPropertyName("content")] public string? Content { get; set; }
    /// <summary>arma | profiles | mpmissions | keys | mods | workshop | modsLibrary</summary>
    [JsonPropertyName("root")] public string Root { get; set; } = "arma";
    [JsonPropertyName("skipIfExists")] public bool SkipIfExists { get; set; }
    [JsonPropertyName("libraryPath")] public string? LibraryPath { get; set; }
}

public static class FileOps
{
    private static readonly HashSet<string> TextReadableExt = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".cfg", ".rpt", ".html", ".htm", ".log", ".json", ".xml", ".ini", ".sqf", ".hpp", ".ext", ".Arma3Profile",
    };

    private const int DefaultMaxReadBytes = 2 * 1024 * 1024;
    public static ResultBody Deploy(AgentConfig cfg, FileDeployPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.RelativePath))
            return Fail("relativePath required");

        string full;
        try { full = ResolvePath(cfg, p.Root, p.RelativePath, mustExist: false, p.LibraryPath); }
        catch (Exception ex) { return Fail(ex.Message); }

        if (p.SkipIfExists && File.Exists(full))
        {
            var existing = new FileInfo(full);
            return new ResultBody
            {
                Ok = true,
                Final = true,
                Message = "already present",
                Data = new Dictionary<string, object>
                {
                    ["path"] = full,
                    ["bytes"] = existing.Length,
                    ["skipped"] = true,
                },
            };
        }

        byte[] bytes;
        try
        {
            if (!string.IsNullOrEmpty(p.ContentBase64))
                bytes = Convert.FromBase64String(p.ContentBase64);
            else if (p.Content is not null)
                bytes = Encoding.UTF8.GetBytes(p.Content);
            else
                return Fail("content or contentBase64 required");
        }
        catch (Exception ex)
        {
            return Fail("invalid content: " + ex.Message);
        }

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllBytes(full, bytes);
        }
        catch (Exception ex)
        {
            return Fail("write failed: " + ex.Message);
        }

        return new ResultBody
        {
            Ok = true,
            Final = true,
            Message = "deployed",
            Data = new Dictionary<string, object>
            {
                ["path"] = full,
                ["bytes"] = bytes.Length,
                ["skipped"] = false,
            },
        };
    }

    public static ResultBody List(AgentConfig cfg, FileListPayload p)
    {
        string dir;
        try { dir = ResolvePath(cfg, p.Root, string.IsNullOrWhiteSpace(p.RelativePath) ? "" : p.RelativePath, mustExist: false, p.LibraryPath); }
        catch (Exception ex) { return Fail(ex.Message); }

        if (!Directory.Exists(dir))
        {
            return new ResultBody
            {
                Ok = true,
                Final = true,
                Message = "directory missing",
                Data = new Dictionary<string, object>
                {
                    ["path"] = dir,
                    ["exists"] = false,
                    ["entries"] = Array.Empty<object>(),
                },
            };
        }

        var entries = new List<Dictionary<string, object>>();
        try
        {
            foreach (var d in Directory.EnumerateDirectories(dir).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var name = Path.GetFileName(d);
                entries.Add(new Dictionary<string, object>
                {
                    ["name"] = name,
                    ["path"] = RelFromRoot(cfg, p.Root, d, p.LibraryPath),
                    ["isDir"] = true,
                    ["size"] = 0,
                });
            }
            foreach (var f in Directory.EnumerateFiles(dir).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var fi = new FileInfo(f);
                entries.Add(new Dictionary<string, object>
                {
                    ["name"] = fi.Name,
                    ["path"] = RelFromRoot(cfg, p.Root, f, p.LibraryPath),
                    ["isDir"] = false,
                    ["size"] = fi.Length,
                    ["mtime"] = fi.LastWriteTimeUtc.ToString("o"),
                });
            }
        }
        catch (Exception ex)
        {
            return Fail("list failed: " + ex.Message);
        }

        return new ResultBody
        {
            Ok = true,
            Final = true,
            Message = $"{entries.Count} entries",
            Data = new Dictionary<string, object>
            {
                ["path"] = dir,
                ["exists"] = true,
                ["root"] = p.Root,
                ["relativePath"] = p.RelativePath ?? "",
                ["entries"] = entries.ToArray(),
            },
        };
    }

    public static ResultBody Read(AgentConfig cfg, FileReadPayload p)
    {
        if (string.IsNullOrWhiteSpace(p.RelativePath))
            return Fail("relativePath required");

        string full;
        try { full = ResolvePath(cfg, p.Root, p.RelativePath, mustExist: true, p.LibraryPath); }
        catch (Exception ex) { return Fail(ex.Message); }

        if (!File.Exists(full))
            return Fail("not a file");

        var name = Path.GetFileName(full);
        var ext = Path.GetExtension(full);
        var allowed = TextReadableExt.Contains(ext)
            || name.EndsWith(".Arma3Profile", StringComparison.OrdinalIgnoreCase);
        if (!allowed)
            return Fail($"file type not viewable as text (allowed: .txt, .cfg, .rpt, .html, …)");

        var maxBytes = p.MaxBytes > 0 ? p.MaxBytes : DefaultMaxReadBytes;
        if (maxBytes > 8 * 1024 * 1024) maxBytes = 8 * 1024 * 1024;

        try
        {
            var fi = new FileInfo(full);
            var truncated = fi.Length > maxBytes;
            byte[] bytes;
            using (var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                var toRead = (int)Math.Min(fi.Length, maxBytes);
                bytes = new byte[toRead];
                var read = 0;
                while (read < toRead)
                {
                    var n = fs.Read(bytes, read, toRead - read);
                    if (n <= 0) break;
                    read += n;
                }
                if (read < bytes.Length) Array.Resize(ref bytes, read);
            }

            var content = DecodeText(bytes);
            return new ResultBody
            {
                Ok = true,
                Final = true,
                Message = truncated ? "truncated" : "ok",
                Data = new Dictionary<string, object>
                {
                    ["path"] = full,
                    ["relativePath"] = RelFromRoot(cfg, p.Root, full),
                    ["root"] = p.Root,
                    ["size"] = fi.Length,
                    ["truncated"] = truncated,
                    ["encoding"] = "utf-8",
                    ["content"] = content,
                },
            };
        }
        catch (Exception ex)
        {
            return Fail("read failed: " + ex.Message);
        }
    }

    private static string DecodeText(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
            return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);

        // Prefer UTF-8; fall back to Windows-1252 for typical .rpt logs
        try
        {
            var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
            return utf8.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            try
            {
                return Encoding.GetEncoding(1252).GetString(bytes);
            }
            catch
            {
                return Encoding.UTF8.GetString(bytes);
            }
        }
    }

    private static string ResolvePath(AgentConfig cfg, string rootKind, string relative, bool mustExist, string? libraryPath = null)
    {
        var baseDir = RootDir(cfg, rootKind, libraryPath);
        Directory.CreateDirectory(baseDir);
        var combined = string.IsNullOrWhiteSpace(relative)
            ? baseDir
            : Path.GetFullPath(Path.Combine(baseDir, relative));
        var rootFull = Path.GetFullPath(baseDir);
        if (!combined.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("path escapes root");
        if (mustExist && !Directory.Exists(combined) && !File.Exists(combined))
            throw new InvalidOperationException("path not found");
        return combined;
    }

    private static string RootDir(AgentConfig cfg, string rootKind, string? libraryPath = null)
    {
        var arma = cfg.ArmaRoot;
        var kind = string.IsNullOrWhiteSpace(rootKind) ? "arma" : rootKind.Trim().ToLowerInvariant();
        return kind switch
        {
            "arma" => arma,
            "profiles" => Path.Combine(arma, "profiles"),
            "mpmissions" => Path.Combine(arma, "mpmissions"),
            "keys" => Path.Combine(arma, "keys"),
            "mods" => Path.Combine(arma, "mods"),
            "workshop" => Path.Combine(arma, "steamapps", "workshop", "content", "107410"),
            "modslibrary" => ModsLibrary.ResolveLibraryPath(cfg, libraryPath),
            _ => throw new InvalidOperationException("unknown root: " + rootKind),
        };
    }

    private static string RelFromRoot(AgentConfig cfg, string rootKind, string full, string? libraryPath = null)
    {
        var root = Path.GetFullPath(RootDir(cfg, rootKind, libraryPath));
        var f = Path.GetFullPath(full);
        if (f.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            return f.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return f;
    }

    private static ResultBody Fail(string error) =>
        new() { Ok = false, Final = true, Error = error, Message = error };
}

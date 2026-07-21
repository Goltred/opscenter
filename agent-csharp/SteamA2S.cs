using System.Net;
using System.Net.Sockets;
using System.Text;

namespace A3Panel.Agent;

/// <summary>Result of a Steam A2S_INFO query (what the launcher / Steam browser sees).</summary>
public sealed class A2SInfoResult
{
    public bool Ok { get; init; }
    public string? Error { get; init; }
    public string Hostname { get; init; } = "";
    public string Map { get; init; } = "";
    public string Folder { get; init; } = "";
    public string Game { get; init; } = "";
    public int Players { get; init; }
    public int MaxPlayers { get; init; }
    public int Bots { get; init; }
    public bool Password { get; init; }
    public string Version { get; init; } = "";
    public int QueryPort { get; init; }
    public DateTime QueriedAt { get; init; } = DateTime.UtcNow;
}

/// <summary>
/// Steam Source A2S_INFO (UDP). Arma 3 answers on gamePort+1.
/// </summary>
public static class SteamA2S
{
    private static readonly byte[] InfoRequestPrefix =
    {
        0xFF, 0xFF, 0xFF, 0xFF,
        0x54, // 'T' A2S_INFO
    };

    private static readonly byte[] InfoQueryString = Encoding.UTF8.GetBytes("Source Engine Query\0");

    public static A2SInfoResult Query(string host, int queryPort, int timeoutMs = 900)
    {
        try
        {
            using var udp = new UdpClient();
            udp.Client.ReceiveTimeout = timeoutMs;
            udp.Client.SendTimeout = timeoutMs;
            udp.Connect(host, queryPort);

            var req = BuildInfoRequest(null);
            udp.Send(req, req.Length);

            var remote = new IPEndPoint(IPAddress.Any, 0);
            var resp = udp.Receive(ref remote);
            if (resp.Length < 5)
                return Fail(queryPort, "empty A2S response");

            // Challenge: FF FF FF FF 41 <int32>
            if (resp[4] == 0x41 && resp.Length >= 9)
            {
                var challenge = new byte[4];
                Buffer.BlockCopy(resp, 5, challenge, 0, 4);
                req = BuildInfoRequest(challenge);
                udp.Send(req, req.Length);
                resp = udp.Receive(ref remote);
                if (resp.Length < 5)
                    return Fail(queryPort, "empty A2S response after challenge");
            }

            if (resp[4] != 0x49) // 'I' A2S_INFO
                return Fail(queryPort, $"unexpected A2S header 0x{resp[4]:X2}");

            return ParseInfo(resp, queryPort);
        }
        catch (SocketException ex)
        {
            return Fail(queryPort, ex.SocketErrorCode == SocketError.TimedOut
                ? "query timeout (server may still be starting)"
                : ex.Message);
        }
        catch (Exception ex)
        {
            return Fail(queryPort, ex.Message);
        }
    }

    /// <summary>Arma 3 Steam query = game port + 1; fall back to game port if needed.</summary>
    public static A2SInfoResult QueryArma(string host, int gamePort, int timeoutMs = 900)
    {
        var primary = Query(host, gamePort + 1, timeoutMs);
        if (primary.Ok) return primary;
        var fallback = Query(host, gamePort, timeoutMs);
        if (fallback.Ok) return fallback;
        return primary; // prefer the canonical +1 error
    }

    private static byte[] BuildInfoRequest(byte[]? challenge)
    {
        var len = InfoRequestPrefix.Length + InfoQueryString.Length + (challenge?.Length ?? 0);
        var buf = new byte[len];
        Buffer.BlockCopy(InfoRequestPrefix, 0, buf, 0, InfoRequestPrefix.Length);
        Buffer.BlockCopy(InfoQueryString, 0, buf, InfoRequestPrefix.Length, InfoQueryString.Length);
        if (challenge is { Length: > 0 })
            Buffer.BlockCopy(challenge, 0, buf, InfoRequestPrefix.Length + InfoQueryString.Length, challenge.Length);
        return buf;
    }

    private static A2SInfoResult ParseInfo(byte[] resp, int queryPort)
    {
        // Header 4 + type 1 + protocol 1
        var i = 6;
        string ReadString()
        {
            var start = i;
            while (i < resp.Length && resp[i] != 0) i++;
            var s = Encoding.UTF8.GetString(resp, start, Math.Max(0, i - start));
            if (i < resp.Length) i++; // skip NUL
            return s;
        }

        byte ReadByte() => i < resp.Length ? resp[i++] : (byte)0;
        short ReadShort()
        {
            if (i + 1 >= resp.Length) return 0;
            var v = (short)(resp[i] | (resp[i + 1] << 8));
            i += 2;
            return v;
        }

        var hostname = ReadString();
        var map = ReadString();
        var folder = ReadString();
        var game = ReadString();
        _ = ReadShort(); // steam app id
        var players = ReadByte();
        var maxPlayers = ReadByte();
        var bots = ReadByte();
        _ = ReadByte(); // server type
        _ = ReadByte(); // environment
        var visibility = ReadByte(); // 0 public, 1 private
        _ = ReadByte(); // VAC
        var version = ReadString();

        return new A2SInfoResult
        {
            Ok = true,
            Hostname = hostname,
            Map = map,
            Folder = folder,
            Game = game,
            Players = players,
            MaxPlayers = maxPlayers,
            Bots = bots,
            Password = visibility != 0,
            Version = version,
            QueryPort = queryPort,
            QueriedAt = DateTime.UtcNow,
        };
    }

    private static A2SInfoResult Fail(int queryPort, string error) =>
        new() { Ok = false, Error = error, QueryPort = queryPort, QueriedAt = DateTime.UtcNow };
}

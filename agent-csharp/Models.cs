using System.Text.Json.Serialization;

namespace A3Panel.Agent;

public sealed class AgentConfig
{
    public string ControlPlaneUrl { get; set; } = "ws://127.0.0.1:8443/agent/connect";
    public string HostId { get; set; } = "";
    public string EnrollToken { get; set; } = "";
    public string ArmaRoot { get; set; } = @"C:\arma3server";
    /// <summary>
    /// Folder of workshop mods as {id}\ subdirs. Empty = {ArmaRoot}\steamapps\workshop\content\107410.
    /// Keep in sync with the panel host "mods library" setting.
    /// </summary>
    public string ModsLibraryPath { get; set; } = "";
    public string SteamCmdPath { get; set; } = @"C:\steamcmd\steamcmd.exe";
    public Dictionary<string, SteamAccount> SteamAccounts { get; set; } = new();
}

public sealed class SteamAccount
{
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
}

public sealed class Envelope
{
    [JsonPropertyName("kind")] public string Kind { get; set; } = "";
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("op")] public string? Op { get; set; }
    [JsonPropertyName("payload")] public object? Payload { get; set; }
    [JsonPropertyName("result")] public ResultBody? Result { get; set; }
    [JsonPropertyName("hello")] public HelloBody? Hello { get; set; }
    [JsonPropertyName("heartbeat")] public HeartbeatBody? Heartbeat { get; set; }
}

public sealed class ResultBody
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("final")] public bool Final { get; set; }
    [JsonPropertyName("stage")] public string? Stage { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("data")] public Dictionary<string, object>? Data { get; set; }
    [JsonPropertyName("logLine")] public string? LogLine { get; set; }
}

public sealed class HelloBody
{
    [JsonPropertyName("agentVersion")] public string AgentVersion { get; set; } = "0.1.0";
    [JsonPropertyName("hostId")] public string HostId { get; set; } = "";
    [JsonPropertyName("os")] public string Os { get; set; } = "windows";
    [JsonPropertyName("capabilities")] public string[] Capabilities { get; set; } = ["steamcmd", "process"];
}

public sealed class HeartbeatBody
{
    [JsonPropertyName("instances")] public Dictionary<string, object>? Instances { get; set; }
    /// <summary>HC worker groups keyed by group id.</summary>
    [JsonPropertyName("hcGroups")] public Dictionary<string, object>? HcGroups { get; set; }
    /// <summary>arma3server processes not claimed by any tracked instance.</summary>
    [JsonPropertyName("orphans")] public List<Dictionary<string, object?>>? Orphans { get; set; }
    [JsonPropertyName("steamcmdRunning")] public bool SteamcmdRunning { get; set; }
    [JsonPropertyName("steamcmdPid")] public int? SteamcmdPid { get; set; }
}

public sealed class HcGroupControlPayload
{
    [JsonPropertyName("groupId")] public string GroupId { get; set; } = "";
    [JsonPropertyName("armaRoot")] public string? ArmaRoot { get; set; }
    [JsonPropertyName("headless")] public List<HeadlessSpecPayload>? Headless { get; set; }
    [JsonPropertyName("desiredCount")] public int? DesiredCount { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
}

public sealed class CancelPayload
{
    [JsonPropertyName("jobId")] public string? JobId { get; set; }
}

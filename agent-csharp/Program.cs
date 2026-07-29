using System.Text.Json;
using OpsCenter.Agent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var configPath = args.FirstOrDefault(a => !a.StartsWith("-")) 
    ?? Path.Combine(AppContext.BaseDirectory, "agent.json");

if (!File.Exists(configPath))
{
    var example = Path.Combine(AppContext.BaseDirectory, "agent.example.json");
    Console.Error.WriteLine($"Missing {configPath}. Copy agent.example.json to agent.json and edit hostId / paths.");
    if (File.Exists(example)) Console.Error.WriteLine($"Example at {example}");
    return 1;
}

var cfg = JsonSerializer.Deserialize<AgentConfig>(await File.ReadAllTextAsync(configPath),
    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
    ?? throw new InvalidOperationException("invalid agent.json");

if (string.IsNullOrWhiteSpace(cfg.HostId))
{
    Console.Error.WriteLine("agent.json hostId is required (use the host UUID from the panel).");
    return 1;
}

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "OpsCenter Agent");
builder.Services.AddSingleton(cfg);
builder.Services.AddHostedService<AgentWorker>();

var host = builder.Build();
await host.RunAsync();
return 0;

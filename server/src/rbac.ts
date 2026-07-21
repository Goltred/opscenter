export const ALL_PERMISSIONS = [
  "host.add",
  "host.remove",
  "host.reboot",
  "instance.view",
  "instance.control",
  "instance.config.edit",
  "instance.rcon",
  "mod.manage",
  "mission.upload",
  "mission.manage",
  "profile.view",
  "profile.edit",
  "profile.apply",
  "profile.delete",
  "schedule.manage",
  "discord.config",
  "steam.config",
  "user.manage",
  "audit.view",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export type SeedRole = {
  name: string;
  description: string;
  permissions: readonly string[];
  builtin: boolean;
};

export const SEED_ROLES: SeedRole[] = [
  {
    name: "Owner",
    description: "Full access to everything.",
    permissions: ALL_PERMISSIONS,
    builtin: true,
  },
  {
    name: "Infrastructure",
    description: "Add/remove hosts and manage Steam credentials.",
    permissions: ["host.add", "host.remove", "steam.config", "instance.view"],
    builtin: false,
  },
  {
    name: "Instance Operator",
    description: "Start/stop/restart and run RCON on assigned instances.",
    permissions: ["instance.view", "instance.control", "instance.rcon", "instance.config.edit"],
    builtin: false,
  },
  {
    name: "Mission Manager",
    description: "Manage mission profiles, uploads, mods and schedules.",
    permissions: [
      "profile.view",
      "profile.edit",
      "profile.apply",
      "profile.delete",
      "mission.upload",
      "mission.manage",
      "mod.manage",
      "schedule.manage",
      "instance.view",
    ],
    builtin: false,
  },
  {
    name: "Viewer",
    description: "Read-only visibility.",
    permissions: ["instance.view", "profile.view", "audit.view"],
    builtin: false,
  },
];

export type Grant = {
  permission: string;
  scopeType: string;
  scopeId?: string;
};

export function hasPermission(grants: Grant[], permission: string, scopeType = "global", scopeId = ""): boolean {
  return grants.some((g) => {
    if (g.permission !== permission) return false;
    if (g.scopeType === "global") return true;
    if (scopeType === "global") return g.scopeType === "global";
    if (g.scopeType !== scopeType) return false;
    return !scopeId || g.scopeId === scopeId;
  });
}

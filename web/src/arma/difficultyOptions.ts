/** Custom difficulty options for server.Arma3Profile (mirrors server catalog). */

export type DifficultyPresetName = "Recruit" | "Regular" | "Veteran" | "Custom";

export type DifficultyOptionDef = {
  key: string;
  label: string;
  max: 1 | 2 | 3;
  group: string;
};

export const DIFFICULTY_OPTIONS: DifficultyOptionDef[] = [
  { key: "reducedDamage", label: "Reduced damage", max: 1, group: "Simulation" },
  { key: "groupIndicators", label: "Group indicators", max: 2, group: "Situational awareness" },
  { key: "friendlyTags", label: "Friendly name tags", max: 2, group: "Situational awareness" },
  { key: "enemyTags", label: "Enemy name tags", max: 2, group: "Situational awareness" },
  { key: "detectedMines", label: "Detected mines", max: 2, group: "Situational awareness" },
  { key: "commands", label: "Commands", max: 2, group: "Situational awareness" },
  { key: "waypoints", label: "Waypoints", max: 2, group: "Situational awareness" },
  { key: "tacticalPing", label: "Tactical ping", max: 3, group: "Situational awareness" },
  { key: "weaponInfo", label: "Weapon info", max: 2, group: "Personal awareness" },
  { key: "stanceIndicator", label: "Stance indicator", max: 2, group: "Personal awareness" },
  { key: "staminaBar", label: "Stamina bar", max: 1, group: "Personal awareness" },
  { key: "weaponCrosshair", label: "Weapon crosshair", max: 1, group: "Personal awareness" },
  { key: "visionAid", label: "Vision aid", max: 1, group: "Personal awareness" },
  { key: "thirdPersonView", label: "3rd person view", max: 2, group: "View" },
  { key: "cameraShake", label: "Camera shake", max: 1, group: "View" },
  { key: "scoreTable", label: "Score table", max: 1, group: "Multiplayer" },
  { key: "deathMessages", label: "Killed by", max: 1, group: "Multiplayer" },
  { key: "vonID", label: "VoN ID", max: 1, group: "Multiplayer" },
  { key: "mapContent", label: "Extended map content", max: 1, group: "Misc" },
  { key: "autoReport", label: "Auto report", max: 1, group: "Misc" },
  { key: "multipleSaves", label: "Multiple saves", max: 1, group: "Misc" },
];

export type CustomDifficulty = {
  options: Record<string, number>;
  aiLevelPreset: number;
  skillAI: number;
  precisionAI: number;
};

export const DEFAULT_CUSTOM_DIFFICULTY: CustomDifficulty = {
  options: {
    reducedDamage: 0,
    groupIndicators: 0,
    friendlyTags: 0,
    enemyTags: 0,
    detectedMines: 0,
    commands: 1,
    waypoints: 1,
    tacticalPing: 0,
    weaponInfo: 2,
    stanceIndicator: 2,
    staminaBar: 0,
    weaponCrosshair: 0,
    visionAid: 0,
    thirdPersonView: 0,
    cameraShake: 1,
    scoreTable: 1,
    deathMessages: 1,
    vonID: 1,
    mapContent: 0,
    autoReport: 0,
    multipleSaves: 0,
  },
  aiLevelPreset: 3,
  skillAI: 0.5,
  precisionAI: 0.5,
};

export function mergeCustomDifficulty(raw?: Partial<CustomDifficulty> | null): CustomDifficulty {
  const base = DEFAULT_CUSTOM_DIFFICULTY;
  if (!raw) return { ...base, options: { ...base.options } };
  return {
    options: { ...base.options, ...(raw.options || {}) },
    aiLevelPreset: raw.aiLevelPreset ?? base.aiLevelPreset,
    skillAI: raw.skillAI ?? base.skillAI,
    precisionAI: raw.precisionAI ?? base.precisionAI,
  };
}

export const FORCED_DIFFICULTY_CHOICES: DifficultyPresetName[] = ["Recruit", "Regular", "Veteran", "Custom"];

export const OPTION_LABELS_2: Record<number, string> = {
  0: "Never",
  1: "Limited / fade",
  2: "Always",
};

export const OPTION_LABELS_3_PING: Record<number, string> = {
  0: "Disabled",
  1: "3D scene",
  2: "Map",
  3: "Both",
};

export const OPTION_LABELS_3P: Record<number, string> = {
  0: "Disabled",
  1: "Enabled",
  2: "Vehicles only",
};

/** Custom difficulty options for server.Arma3Profile (BI wiki DifficultyPresets). */

export type DifficultyPresetName = "Recruit" | "Regular" | "Veteran" | "Custom";

export type DifficultyOptionDef = {
  key: string;
  label: string;
  /** max value inclusive: 1 = toggle, 2 or 3 = select */
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

export function normalizeForcedDifficulty(raw: unknown): DifficultyPresetName | "" {
  const s = String(raw || "").trim();
  if (s === "Recruit" || s === "Regular" || s === "Veteran" || s === "Custom") return s;
  const lower = s.toLowerCase();
  if (lower === "recruit") return "Recruit";
  if (lower === "regular") return "Regular";
  if (lower === "veteran") return "Veteran";
  if (lower === "custom") return "Custom";
  return "";
}

export function normalizeCustomDifficulty(raw: unknown): CustomDifficulty {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const optSrc =
    src.options && typeof src.options === "object" ? (src.options as Record<string, unknown>) : src;
  const options: Record<string, number> = { ...DEFAULT_CUSTOM_DIFFICULTY.options };
  for (const def of DIFFICULTY_OPTIONS) {
    const v = Number(optSrc[def.key]);
    if (Number.isFinite(v)) options[def.key] = Math.max(0, Math.min(def.max, Math.round(v)));
  }
  let aiLevelPreset = Number(src.aiLevelPreset);
  if (!Number.isFinite(aiLevelPreset)) aiLevelPreset = DEFAULT_CUSTOM_DIFFICULTY.aiLevelPreset;
  aiLevelPreset = Math.max(0, Math.min(3, Math.round(aiLevelPreset)));
  let skillAI = Number(src.skillAI);
  if (!Number.isFinite(skillAI)) skillAI = DEFAULT_CUSTOM_DIFFICULTY.skillAI;
  skillAI = Math.max(0, Math.min(1, skillAI));
  let precisionAI = Number(src.precisionAI);
  if (!Number.isFinite(precisionAI)) precisionAI = DEFAULT_CUSTOM_DIFFICULTY.precisionAI;
  precisionAI = Math.max(0, Math.min(1, precisionAI));
  return { options, aiLevelPreset, skillAI, precisionAI };
}

/** Render Users/server/server.Arma3Profile DifficultyPresets block. */
export function renderArma3Profile(custom: CustomDifficulty): string {
  const d = normalizeCustomDifficulty(custom);
  const optLines = DIFFICULTY_OPTIONS.map((def) => {
    const v = d.options[def.key] ?? 0;
    return `\t\t\t${def.key} = ${v};`;
  });
  return [
    "class DifficultyPresets",
    "{",
    "\tclass CustomDifficulty",
    "\t{",
    "\t\tclass Options",
    "\t\t{",
    ...optLines,
    "\t\t};",
    `\t\taiLevelPreset = ${d.aiLevelPreset};`,
    "\t};",
    "\tclass CustomAILevel",
    "\t{",
    `\t\tskillAI = ${d.skillAI};`,
    `\t\tprecisionAI = ${d.precisionAI};`,
    "\t};",
    "};",
    "",
  ].join("\n");
}

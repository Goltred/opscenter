export type ThemeId = "legacy" | "steel-brief" | "night-optics" | "signal" | "foundry" | "range";

export type ThemeOption = {
  id: ThemeId;
  name: string;
  pitch: string;
  mood: string;
  accentHex: string;
  surfaceHex: string;
};

/** Locked product brand. */
export const PRODUCT_BRAND = {
  mark: "Ops",
  accentPart: "Center",
  tagline: "Dedicated server operations",
  fullName: "OpsCenter",
} as const;

export const THEMES: ThemeOption[] = [
  {
    id: "legacy",
    name: "Legacy Blue",
    pitch: "Original developer-tool dark UI.",
    mood: "Familiar · developer tool",
    accentHex: "#2f81f7",
    surfaceHex: "#161b22",
  },
  {
    id: "steel-brief",
    name: "Steel Brief",
    pitch: "NATO briefing desk: charcoal, olive, brass.",
    mood: "Military · restrained · authoritative",
    accentHex: "#c4a35a",
    surfaceHex: "#151914",
  },
  {
    id: "night-optics",
    name: "Night Optics",
    pitch: "NVG console: near-black with phosphor green.",
    mood: "Tactical HUD · low light · precise",
    accentHex: "#5cdb95",
    surfaceHex: "#0c1210",
  },
  {
    id: "signal",
    name: "Signal Deck",
    pitch: "Radio room slate with desaturated cobalt.",
    mood: "C2 · automation · calm focus",
    accentHex: "#5b8def",
    surfaceHex: "#12161e",
  },
  {
    id: "foundry",
    name: "Foundry",
    pitch: "Warm industrial black with copper heat.",
    mood: "Build/deploy · workshop · modern forge",
    accentHex: "#d08a4c",
    surfaceHex: "#171310",
  },
  {
    id: "range",
    name: "Live Range",
    pitch: "Concrete ops floor with sand ochre marks.",
    mood: "Field · arid · contemporary",
    accentHex: "#d2a15a",
    surfaceHex: "#161512",
  },
];

const THEME_KEY = "opscenter.theme";
const THEME_KEY_LEGACY = "a3p.preview.theme";

export function readStoredTheme(): ThemeId {
  const v = (localStorage.getItem(THEME_KEY) || localStorage.getItem(THEME_KEY_LEGACY)) as ThemeId | null;
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : "steel-brief";
}

export function persistTheme(id: ThemeId) {
  localStorage.setItem(THEME_KEY, id);
}

export function applyThemeToDocument(id: ThemeId) {
  document.documentElement.setAttribute("data-theme", id);
}

export function brandDocumentTitle() {
  document.title = `${PRODUCT_BRAND.mark}${PRODUCT_BRAND.accentPart} — ${PRODUCT_BRAND.tagline}`;
}

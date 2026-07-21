/** Creator DLC short codes for -mod= (require Steam branch creatordlc). */
export type CreatorDlc = {
  code: string;
  name: string;
  steamAppId?: number;
};

export const CREATOR_DLCS: CreatorDlc[] = [
  { code: "gm", name: "Global Mobilization", steamAppId: 1042220 },
  { code: "vn", name: "S.O.G. Prairie Fire", steamAppId: 1227700 },
  { code: "ws", name: "Western Sahara", steamAppId: 1681170 },
  { code: "spe", name: "Spearhead 1944", steamAppId: 1175380 },
  { code: "csla", name: "CSLA Iron Curtain", steamAppId: 1294440 },
  { code: "rf", name: "Reaction Forces", steamAppId: 2647760 },
  { code: "ef", name: "Expeditionary Forces", steamAppId: 2647830 },
];

export const CREATOR_DLC_CODES = new Set(CREATOR_DLCS.map((d) => d.code));

export function normalizeDlcCodes(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const x of arr) {
    const code = String(x || "").trim().toLowerCase();
    if (CREATOR_DLC_CODES.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

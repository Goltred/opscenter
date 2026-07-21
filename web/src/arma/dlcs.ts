/** Creator DLC short codes for -mod= (require Steam branch creatordlc). */
export type CreatorDlc = {
  code: string;
  name: string;
};

export const CREATOR_DLCS: CreatorDlc[] = [
  { code: "gm", name: "Global Mobilization" },
  { code: "vn", name: "S.O.G. Prairie Fire" },
  { code: "ws", name: "Western Sahara" },
  { code: "spe", name: "Spearhead 1944" },
  { code: "csla", name: "CSLA Iron Curtain" },
  { code: "rf", name: "Reaction Forces" },
  { code: "ef", name: "Expeditionary Forces" },
];

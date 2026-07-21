export type ModlistEntry = {
  workshopId: string;
  name?: string;
  kind: "client" | "server";
};

/**
 * Parse Arma Launcher modlist.html / exported HTML for Steam Workshop IDs.
 * Looks for sharedfiles / filedetails links and ?id= workshop query params.
 */
export function parseArmaModlistHtml(html: string): ModlistEntry[] {
  const found = new Map<string, ModlistEntry>();

  // <a href="...steamcommunity.com/.../filedetails/?id=123...">Name</a>
  const linkRe =
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const id = extractWorkshopId(href);
    if (!id) continue;
    const name = stripTags(m[2]).trim() || undefined;
    if (!found.has(id)) {
      found.set(id, { workshopId: id, name, kind: "client" });
    } else if (name && !found.get(id)!.name) {
      found.get(id)!.name = name;
    }
  }

  // Bare URLs / query params not wrapped in matching anchors
  const idRe =
    /(?:filedetails\/\?id=|sharedfiles\/filedetails\/\?id=|[?&]id=)(\d{5,})/gi;
  while ((m = idRe.exec(html))) {
    const id = m[1];
    if (!found.has(id)) found.set(id, { workshopId: id, kind: "client" });
  }

  // Mod list rows sometimes embed data-id / workshop id attributes
  const attrRe = /(?:data-id|data-workshop-id|workshop[_-]?id)\s*=\s*["']?(\d{5,})/gi;
  while ((m = attrRe.exec(html))) {
    const id = m[1];
    if (!found.has(id)) found.set(id, { workshopId: id, kind: "client" });
  }

  return [...found.values()];
}

function extractWorkshopId(href: string): string | null {
  const m =
    href.match(/filedetails\/\?id=(\d+)/i) ||
    href.match(/[?&]id=(\d{5,})/i) ||
    href.match(/sharedfiles\/(\d+)/i);
  return m ? m[1] : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

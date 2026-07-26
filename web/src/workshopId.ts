/** Accept a raw workshop ID or a Steam workshop URL. */
export function parseWorkshopId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{5,}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const id = u.searchParams.get("id");
    if (id && /^\d+$/.test(id)) return id;
  } catch {
    /* not a full URL */
  }
  const m = /[?&]id=(\d+)/i.exec(s) || /filedetails\/.*?[/=](\d{5,})/i.exec(s);
  return m ? m[1] : null;
}

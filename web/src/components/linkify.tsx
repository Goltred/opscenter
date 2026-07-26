import type { ReactNode } from "react";

export type LinkifyOpts = {
  /** Workshop ID → display name (from panel mods library). */
  modNames?: Map<string, string>;
};

/** Turn http(s) URLs (and bare Steam workshop IDs) into clickable links. */
export function linkifyText(text: string, opts?: LinkifyOpts): ReactNode {
  const parts = String(text || "").split(/(https?:\/\/[^\s<>"']+|\b\d{7,12}\b)/g);
  return parts.map((part, i) => {
    if (/^https?:\/\//i.test(part)) {
      const href = part.replace(/[.,);]+$/, "");
      const trail = part.slice(href.length);
      return (
        <span key={i}>
          <a href={href} target="_blank" rel="noreferrer">
            {href}
          </a>
          {trail}
        </span>
      );
    }
    if (/^\d{7,12}$/.test(part)) {
      const name = opts?.modNames?.get(part)?.trim();
      const label = name && name !== part ? name : part;
      return (
        <a
          key={i}
          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${part}`}
          target="_blank"
          rel="noreferrer"
          title={label !== part ? `Workshop ${part}` : undefined}
        >
          {label}
        </a>
      );
    }
    return part;
  });
}

import { useEffect, useState } from "react";
import { api, Mod } from "./api";

/** Workshop ID → readable mod name from the panel library. */
export function useModNameMap() {
  const [modNames, setModNames] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    api
      .get<Mod[]>("/mods")
      .then((rows) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const m of rows || []) {
          const id = String(m.workshopId || "").trim();
          const name = String(m.name || "").trim();
          if (id && name) map.set(id, name);
        }
        setModNames(map);
      })
      .catch(() => {
        if (!cancelled) setModNames(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return modNames;
}

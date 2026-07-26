import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyThemeToDocument,
  brandDocumentTitle,
  persistTheme,
  PRODUCT_BRAND,
  readStoredTheme,
  THEMES,
  type ThemeId,
  type ThemeOption,
} from "./catalog";

type AppearanceCtx = {
  themeId: ThemeId;
  theme: ThemeOption;
  setThemeId: (id: ThemeId) => void;
  brand: typeof PRODUCT_BRAND;
};

const Ctx = createContext<AppearanceCtx | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => readStoredTheme());
  const theme = useMemo(() => THEMES.find((t) => t.id === themeId) || THEMES[0], [themeId]);

  useEffect(() => {
    applyThemeToDocument(themeId);
    persistTheme(themeId);
  }, [themeId]);

  useEffect(() => {
    brandDocumentTitle();
  }, []);

  return (
    <Ctx.Provider
      value={{
        themeId,
        theme,
        setThemeId: setThemeIdState,
        brand: PRODUCT_BRAND,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAppearance() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppearance requires AppearanceProvider");
  return ctx;
}

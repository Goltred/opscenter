import { useState } from "react";
import { THEMES } from "../theme/catalog";
import { useAppearance } from "../theme/AppearanceProvider";

/** Permanent theme preference — saved and restored on revisit. */
export function AppearancePanel() {
  const { themeId, theme, setThemeId } = useAppearance();
  const [open, setOpen] = useState(false);

  return (
    <div className={"appearance-dock" + (open ? " is-open" : "")}>
      <button type="button" className="appearance-dock-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Close appearance" : "Appearance"}
      </button>
      {open && (
        <div className="appearance-dock-panel card">
          <div className="theme-lab-head">
            <div>
              <strong>Appearance</strong>
              <div className="muted small">Your color theme is saved on this browser.</div>
            </div>
          </div>
          <div className="theme-lab-grid themes">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={"theme-lab-choice theme-swatch" + (themeId === t.id ? " is-active" : "")}
                onClick={() => setThemeId(t.id)}
              >
                <span className="theme-lab-swatches" aria-hidden>
                  <i style={{ background: t.surfaceHex }} />
                  <i style={{ background: t.accentHex }} />
                </span>
                <span className="theme-lab-choice-title">{t.name}</span>
                <span className="muted small">{t.mood}</span>
              </button>
            ))}
          </div>
          <p className="theme-lab-note muted small">
            <strong>{theme.name}</strong> — {theme.pitch}
          </p>
        </div>
      )}
    </div>
  );
}

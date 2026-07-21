import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

export type ToastTone = "info" | "success" | "error";

export type ToastAction = {
  label: string;
  to?: string;
  href?: string;
};

export type ToastItem = {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  action?: ToastAction;
};

type ToastApi = {
  push: (t: Omit<ToastItem, "id"> & { id?: string; ttlMs?: number }) => void;
  success: (title: string, opts?: { message?: string; action?: ToastAction; ttlMs?: number }) => void;
  error: (title: string, opts?: { message?: string; action?: ToastAction; ttlMs?: number }) => void;
  info: (title: string, opts?: { message?: string; action?: ToastAction; ttlMs?: number }) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast requires ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<ToastItem, "id"> & { id?: string; ttlMs?: number }) => {
      const id = t.id || crypto.randomUUID();
      const item: ToastItem = {
        id,
        tone: t.tone,
        title: t.title,
        message: t.message,
        action: t.action,
      };
      setItems((prev) => [...prev.slice(-4), item]);
      const ttl = t.ttlMs ?? (t.tone === "error" ? 10_000 : 6_000);
      window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, opts) => push({ tone: "success", title, ...opts }),
      error: (title, opts) => push({ tone: "error", title, ...opts }),
      info: (title, opts) => push({ tone: "info", title, ...opts }),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.message && <div className="muted small">{t.message}</div>}
              {t.action && (
                <div style={{ marginTop: 6 }}>
                  {t.action.to ? (
                    <Link to={t.action.to} onClick={() => dismiss(t.id)}>{t.action.label}</Link>
                  ) : t.action.href ? (
                    <a href={t.action.href} target="_blank" rel="noreferrer">{t.action.label}</a>
                  ) : null}
                </div>
              )}
            </div>
            <button type="button" className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

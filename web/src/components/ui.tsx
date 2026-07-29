import { useEffect, useState, useCallback } from "react";

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Sticky action bar (Save / History / Cancel). Body scrolls independently. */
  footer?: React.ReactNode;
  /** Wider dialog for dense forms (e.g. profile editor). Still capped by viewport. */
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`card modal${wide ? " modal-wide" : ""}${footer ? " modal-with-footer" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header row between">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer != null && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function StatusBadge({ state, online }: { state: string; online?: boolean }) {
  const raw = String(state || "").toLowerCase();
  if (online === false && raw !== "starting" && raw !== "running") {
    return <span className="badge"><span className="dot" /> Offline</span>;
  }
  let dot = "";
  let label = state || "unknown";
  switch (raw) {
    case "running":
      dot = "green";
      label = "Running";
      break;
    case "starting":
      dot = "yellow";
      label = "Starting";
      break;
    case "stopping":
      dot = "yellow";
      label = "Stopping";
      break;
    case "crashed":
      dot = "red";
      label = "Crashed";
      break;
    case "stopped":
    case "offline":
      dot = "";
      label = "Offline";
      break;
    default:
      label = state;
  }
  return <span className="badge"><span className={"dot " + dot} /> {label}</span>;
}

/** Horizontal on/off switch — green when on, red when off. */
export function StatusToggle({
  checked,
  onChange,
  disabled,
  onLabel = "On",
  offLabel = "Off",
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
  title?: string;
}) {
  return (
    <label
      className={"status-toggle" + (checked ? " is-on" : " is-off") + (disabled ? " is-disabled" : "")}
      title={title}
    >
      <input
        type="checkbox"
        className="status-toggle-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="status-toggle-track" aria-hidden>
        <span className="status-toggle-label status-toggle-label--on">{onLabel}</span>
        <span className="status-toggle-label status-toggle-label--off">{offLabel}</span>
        <span className="status-toggle-knob" />
      </span>
      <span className="sr-only">{checked ? onLabel : offLabel}</span>
    </label>
  );
}

// useList: simple data loader with refresh.
export function useList<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    loader()
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError(e.message || "error"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

import { useState } from "react";
import { api } from "../api";
import { Modal } from "./ui";

export type FinishScheduleTarget = {
  scheduleId: string;
  name: string;
  fallbackProfileName?: string;
  instanceName?: string;
};

export function FinishScheduleModal({
  target,
  onClose,
  onFinished,
}: {
  target: FinishScheduleTarget;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const opName = target.name || "operation";
  const fallback = target.fallbackProfileName || "the fallback profile";

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/schedules/${target.scheduleId}/finish`);
      onFinished();
      onClose();
    } catch (e: any) {
      setError(e.message || "Finish failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Finish operation?"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="row" style={{ justifyContent: "flex-end", width: "100%" }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Finishing…" : "Finish and restore"}
          </button>
        </div>
      }
    >
      <p style={{ margin: 0 }}>
        Finish <strong>{opName}</strong>
        {target.instanceName ? (
          <>
            {" "}
            on <strong>{target.instanceName}</strong>
          </>
        ) : null}{" "}
        and restore <strong>{fallback}</strong>?
      </p>
      <p className="muted small" style={{ margin: "10px 0 0" }}>
        This applies the fallback profile and starts the server with its usual setup.
      </p>
      {error ? (
        <div className="error small" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}

import { useState } from "react";
import { api } from "../api";
import { formatDateTimeWeekday } from "../formatTime";
import { Modal } from "./ui";

export type StandDownScheduleTarget = {
  scheduleId: string;
  name: string;
  runAt?: string;
  recurrence?: string;
  instanceName?: string;
};

export function StandDownScheduleModal({
  target,
  onClose,
  onStoodDown,
}: {
  target: StandDownScheduleTarget;
  onClose: () => void;
  onStoodDown: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const opName = target.name || "operation";
  const recurring = target.recurrence === "daily" || target.recurrence === "weekly";
  const when = target.runAt ? formatDateTimeWeekday(target.runAt) : "";

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/schedules/${target.scheduleId}/stand-down`);
      onStoodDown();
      onClose();
    } catch (e: any) {
      setError(e.message || "Stand down failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Stand down this run?"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="row" style={{ justifyContent: "flex-end", width: "100%" }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Keep waiting
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Standing down…" : "Stand down"}
          </button>
        </div>
      }
    >
      <p style={{ margin: 0 }}>
        Stand down <strong>{opName}</strong>
        {target.instanceName ? (
          <>
            {" "}
            on <strong>{target.instanceName}</strong>
          </>
        ) : null}
        {when ? (
          <>
            {" "}
            ({when})
          </>
        ) : null}
        ?
      </p>
      <p className="muted small" style={{ margin: "10px 0 0" }}>
        This occurrence will not apply or start the server. You do not need to wait for confirmation.
        {recurring
          ? " The schedule stays; the next occurrence is set as usual."
          : " The schedule is marked skipped for this run."}
      </p>
      {error ? (
        <div className="error small" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}

import { useRef, useState } from "react";
import { api, uploadSignatureKey, type SignatureKey } from "../api";
import { useToast } from "./Toast";
import { Modal, useList } from "./ui";

/** Panel library of .bikey files — advanced; deploy from an instance. */
export function SignatureKeysLibrary({ compact }: { compact?: boolean }) {
  const toast = useToast();
  const keys = useList<SignatureKey[]>(() => api.get("/signature-keys"));
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadSignatureKey(file);
      }
      keys.reload();
      toast.success(files.length === 1 ? "Key added to library" : `${files.length} keys added`);
    } catch (e: any) {
      toast.error("Upload failed", { message: e.message });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(k: SignatureKey) {
    if (!confirm(`Remove ${k.filename} from the panel library?`)) return;
    try {
      await api.del(`/signature-keys/${k.id}`);
      keys.reload();
    } catch (e: any) {
      toast.error("Delete failed", { message: e.message });
    }
  }

  return (
    <div className={compact ? undefined : "card"} style={compact ? undefined : { marginTop: 16 }}>
      <h2 style={compact ? { fontSize: 15, margin: "0 0 6px" } : undefined}>Signature keys</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Advanced: upload <code>.bikey</code> files here, then push them to a host from an instance (Push signature
        keys). Most setups only need <strong>Sync mod keys</strong>, which copies keys from workshop mods
        automatically.
      </p>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <input
          ref={inputRef}
          type="file"
          accept=".bikey"
          multiple
          hidden
          onChange={(e) => void onFiles(e.target.files)}
        />
        <button type="button" className="btn small" disabled={uploading} onClick={() => inputRef.current?.click()}>
          {uploading ? "Uploading…" : "Upload .bikey"}
        </button>
      </div>
      {keys.loading && !keys.data?.length ? <div className="muted small">Loading…</div> : null}
      {(keys.data || []).length === 0 && !keys.loading ? (
        <div className="muted small">No signature keys in the library yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Filename</th>
              <th>Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(keys.data || []).map((k) => (
              <tr key={k.id}>
                <td>
                  <code>{k.filename}</code>
                </td>
                <td className="muted small">{k.sizeBytes} B</td>
                <td>
                  <button type="button" className="btn small danger" onClick={() => void remove(k)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PushSignatureKeysModal({
  instanceId,
  instanceName,
  onClose,
  onDone,
}: {
  instanceId: string;
  instanceName?: string;
  onClose: () => void;
  onDone: (summary: { deployed: number; failed: number }) => void;
}) {
  const keys = useList<SignatureKey[]>(() => api.get("/signature-keys"));
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const list = keys.data || [];
  const selectedIds = list.filter((k) => selected[k.id]).map((k) => k.id);

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function selectAll() {
    const next: Record<string, boolean> = {};
    for (const k of list) next[k.id] = true;
    setSelected(next);
  }

  async function deploy() {
    if (!selectedIds.length) {
      setError("Select at least one key");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ deployed: number; failed: number }>(`/instances/${instanceId}/keys/deploy`, {
        keyIds: selectedIds,
      });
      onDone({ deployed: r.deployed || 0, failed: r.failed || 0 });
      onClose();
    } catch (e: any) {
      setError(e.message || "Deploy failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Push signature keys"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="row" style={{ justifyContent: "flex-end", width: "100%", gap: 8 }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy || !selectedIds.length} onClick={() => void deploy()}>
            {busy ? "Pushing…" : `Push${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
          </button>
        </div>
      }
    >
      <p style={{ marginTop: 0 }}>
        Copy selected <code>.bikey</code> files into this host&apos;s <code>keys</code> folder
        {instanceName ? (
          <>
            {" "}
            for <strong>{instanceName}</strong>
          </>
        ) : null}
        .
      </p>
      <p className="muted small">
        Prefer <strong>Sync mod keys</strong> when keys ship with workshop mods. Use this for unsigned/extra keys you
        keep in the panel library (Mods → Signature keys).
      </p>
      {keys.loading && !list.length ? <div className="muted small">Loading library…</div> : null}
      {!keys.loading && list.length === 0 ? (
        <div className="muted small">
          Library is empty. Upload <code>.bikey</code> files on the Mods page first.
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button type="button" className="btn small" onClick={selectAll}>
              Select all
            </button>
            <button type="button" className="btn small" onClick={() => setSelected({})}>
              Clear
            </button>
          </div>
          <div style={{ maxHeight: 280, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {list.map((k) => (
              <label key={k.id} className="check-option" style={{ marginBottom: 0 }}>
                <input type="checkbox" checked={!!selected[k.id]} onChange={() => toggle(k.id)} />
                <span className="check-title">
                  <code>{k.filename}</code>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      {error ? (
        <div className="error small" style={{ marginTop: 10 }}>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}

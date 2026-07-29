import { BrandMark } from "../components/BrandMark";
import { useAuth } from "../auth";

export function PendingApproval() {
  const { user, logout, refresh } = useAuth();
  return (
    <div className="login-wrap">
      <div className="card login-card">
        <BrandMark />
        <h2 style={{ margin: "12px 0 8px" }}>Awaiting approval</h2>
        <div className="muted">
          Signed in as <strong>{user?.displayName || user?.email}</strong>. An Owner must approve your account and assign
          a role before you can use the panel.
        </div>
        <div className="warn-banner" style={{ marginTop: 12, textAlign: "left" }}>
          <strong>First install?</strong> If nobody can approve anyone yet, you are not on the Owner allowlist. Edit{" "}
          <code>deploy/control-plane.env</code>, set <code>OC_BOOTSTRAP_OWNERS</code> to your identity (for Discord:{" "}
          <code>discord:YOUR_USER_ID</code>), restart the panel, sign out, and sign in again. See{" "}
          <code>docs/INSTALL.md</code>.
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => refresh()}>
            Refresh
          </button>
          <button className="btn ghost" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

import { useAuth } from "../auth";

export function PendingApproval() {
  const { user, logout, refresh } = useAuth();
  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand">A3<span>Panel</span></div>
        <h2 style={{ margin: "12px 0 8px", fontSize: 18 }}>Awaiting approval</h2>
        <div className="muted">
          Signed in as <strong>{user?.displayName || user?.email}</strong>.
          An Owner must approve your account and assign a role before you can use the panel.
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => refresh()}>Refresh</button>
          <button className="btn ghost" onClick={() => logout()}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

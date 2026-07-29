import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { PanelSetupWizard, SetupStatus } from "../components/PanelSetupWizard";

/** First-run panel setup — shown before the main dashboard when setup is incomplete. */
export function SetupPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!can("host.add")) {
      setLoading(false);
      return;
    }
    api
      .get<SetupStatus>("/setup/status")
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [can]);

  if (!can("host.add")) {
    return <Navigate to="/" replace />;
  }

  if (loading) {
    return (
      <div className="setup-page-wrap">
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (status?.complete) {
    return <Navigate to="/" replace />;
  }

  return <PanelSetupWizard />;
}

function SetupRedirect() {
  const { can, loading: authLoading } = useAuth();
  const loc = useLocation();
  /** Status is only valid for the path it was fetched for — avoids bounce after dismiss. */
  const [state, setState] = useState<{ path: string; status: SetupStatus } | null>(null);

  useEffect(() => {
    if (authLoading || !can("host.add")) return;
    const path = loc.pathname;
    let cancelled = false;
    api
      .get<SetupStatus>("/setup/status")
      .then((status) => {
        if (!cancelled) setState({ path, status });
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, can, loc.pathname]);

  if (loc.pathname === "/setup") return null;
  if (!can("host.add")) return null;
  if (!state || state.path !== loc.pathname) return null;
  if (!state.status.showWizard) return null;
  return <Navigate to="/setup" replace />;
}

export { SetupRedirect };

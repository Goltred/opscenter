import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { PendingApproval } from "./pages/PendingApproval";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { InstancePage } from "./pages/Instance";
import { Mods } from "./pages/Mods";
import { Difficulties } from "./pages/Difficulties";
import { Modlists } from "./pages/Modlists";
import { Missions } from "./pages/Missions";
import { Profiles } from "./pages/Profiles";
import { Schedules } from "./pages/Schedules";
import { Admin } from "./pages/Admin";
import { SetupPage, SetupRedirect } from "./pages/Setup";

/** Old /files bookmarks → Dashboard browse modal. */
function HostFilesRedirect() {
  const [params] = useSearchParams();
  const q = new URLSearchParams();
  q.set("browse", "1");
  const hostId = params.get("hostId");
  const root = params.get("root");
  const path = params.get("path");
  if (hostId) q.set("hostId", hostId);
  if (root) q.set("root", root);
  if (path) q.set("path", path);
  return <Navigate to={`/?${q.toString()}`} replace />;
}

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login />;
  if (!user.approved) return <PendingApproval />;
  return (
    <Layout>
      <SetupRedirect />
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/instances/:id" element={<InstancePage />} />
        <Route path="/files" element={<HostFilesRedirect />} />
        <Route path="/mods" element={<Mods />} />
        <Route path="/modlists" element={<Modlists />} />
        <Route path="/missions" element={<Missions />} />
        <Route path="/difficulties" element={<Difficulties />} />
        <Route path="/profiles" element={<Profiles />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

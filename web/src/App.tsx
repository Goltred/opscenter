import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Login } from "./pages/Login";
import { PendingApproval } from "./pages/PendingApproval";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { InstancePage } from "./pages/Instance";
import { HostFilesPage } from "./pages/HostFiles";
import { Mods } from "./pages/Mods";
import { Modlists } from "./pages/Modlists";
import { Missions } from "./pages/Missions";
import { Profiles } from "./pages/Profiles";
import { Schedules } from "./pages/Schedules";
import { Admin } from "./pages/Admin";

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login />;
  if (!user.approved) return <PendingApproval />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/instances/:id" element={<InstancePage />} />
        <Route path="/files" element={<HostFilesPage />} />
        <Route path="/mods" element={<Mods />} />
        <Route path="/modlists" element={<Modlists />} />
        <Route path="/missions" element={<Missions />} />
        <Route path="/profiles" element={<Profiles />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

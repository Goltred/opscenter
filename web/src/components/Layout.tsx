import { NavLink } from "react-router-dom";
import { useAuth } from "../auth";
import { ActiveActionsPanel } from "./ActiveActionsPanel";

const nav = [
  { to: "/", label: "Dashboard", perm: "instance.view" },
  { to: "/files", label: "Host files", perm: "instance.view" },
  { to: "/mods", label: "Mods", perm: "instance.view" },
  { to: "/modlists", label: "Modlists", perm: "instance.view" },
  { to: "/missions", label: "Missions", perm: "mission.manage" },
  { to: "/profiles", label: "Mission Profiles", perm: "profile.view" },
  { to: "/schedules", label: "Scheduler", perm: "schedule.manage" },
  { to: "/admin", label: "Admin", perm: "user.manage" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, can } = useAuth();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">A3<span>Panel</span></div>
        <nav>
          {nav.map((n) => (
            (n.perm === "instance.view" || can(n.perm) || can("instance.view")) && (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
                {n.label}
              </NavLink>
            )
          ))}
        </nav>
        <ActiveActionsPanel />
        <div className="sidebar-foot">
          <div className="small muted">{user?.email}</div>
          {!user?.mfaEnabled && <div className="small warn">MFA not enabled</div>}
          <button className="btn ghost small" onClick={() => logout()}>Sign out</button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

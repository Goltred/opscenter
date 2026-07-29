import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { PROFILES_HEALTH_EVENT } from "../profilesHealth";
import { STEAM_WEB_API_EVENT } from "../steamWebApiHealth";
import { ActiveActionsPanel } from "./ActiveActionsPanel";
import { BrandMark } from "./BrandMark";
import { FirstMissionGuideListener, FirstMissionGuideNavButton } from "./FirstMissionGuide";
import { UpcomingScheduleBanner, useUpcomingSchedules } from "./UpcomingScheduleBanner";

const nav = [
  { to: "/", label: "Dashboard", perm: "instance.view" },
  { to: "/mods", label: "Mods", perm: "instance.view" },
  { to: "/modlists", label: "Modlists", perm: "instance.view" },
  { to: "/missions", label: "Missions", perm: "mission.manage" },
  { to: "/difficulties", label: "Difficulties", perm: "profile.view" },
  { to: "/profiles", label: "Mission Profiles", perm: "profile.view" },
  { to: "/schedules", label: "Scheduler", perm: "schedule.manage|schedule.confirm|profile.apply|instance.control" },
  { to: "/admin", label: "Admin", perm: "user.manage" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const [invalidProfiles, setInvalidProfiles] = useState(0);
  const [steamWebApiMissing, setSteamWebApiMissing] = useState(false);
  const canViewProfiles = can("profile.view");
  const canSeeAdmin = can("user.manage");
  const upcoming = useUpcomingSchedules();

  useEffect(() => {
    if (!canViewProfiles) {
      setInvalidProfiles(0);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .get<{ count: number }>("/profiles/health")
        .then((h) => {
          if (!cancelled) setInvalidProfiles(Number(h.count) || 0);
        })
        .catch(() => {
          // Don't clear a known warning on a transient failure
          if (!cancelled) {
            /* keep previous count */
          }
        });
    };
    load();
    const id = window.setInterval(load, 30_000);
    const onFocus = () => load();
    const onHealth = () => load();
    window.addEventListener("focus", onFocus);
    window.addEventListener(PROFILES_HEALTH_EVENT, onHealth);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(PROFILES_HEALTH_EVENT, onHealth);
    };
  }, [canViewProfiles, user?.id, location.pathname]);

  useEffect(() => {
    if (!canSeeAdmin) {
      setSteamWebApiMissing(false);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .get<{ configured: boolean }>("/steam/web-api-key")
        .then((r) => {
          if (!cancelled) setSteamWebApiMissing(!r.configured);
        })
        .catch(() => {
          /* keep previous */
        });
    };
    load();
    const id = window.setInterval(load, 60_000);
    const onFocus = () => load();
    const onChanged = () => load();
    window.addEventListener("focus", onFocus);
    window.addEventListener(STEAM_WEB_API_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(STEAM_WEB_API_EVENT, onChanged);
    };
  }, [canSeeAdmin, user?.id, location.pathname]);

  return (
    <div className="app">
      <aside className="sidebar">
        <BrandMark />
        <nav>
          {nav.map((n) => {
            const show = n.perm.split("|").some((p) => can(p)) || can("instance.view");
            if (!show) return null;
            return (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
                <span>{n.label}</span>
                {n.to === "/profiles" && invalidProfiles > 0 && (
                  <span
                    className="nav-alert"
                    title={
                      invalidProfiles === 1
                        ? "1 profile needs a mission"
                        : `${invalidProfiles} profiles need a mission`
                    }
                    aria-label={
                      invalidProfiles === 1
                        ? "1 profile needs a mission"
                        : `${invalidProfiles} profiles need a mission`
                    }
                  >
                    !
                  </span>
                )}
                {n.to === "/schedules" && upcoming.notable.length > 0 && (
                  <span
                    className={"nav-alert" + (upcoming.needsConfirmCount > 0 ? "" : " nav-alert-ok")}
                    title={
                      upcoming.needsConfirmCount > 0
                        ? `${upcoming.needsConfirmCount} upcoming operation(s) need confirmation`
                        : `${upcoming.notable.length} upcoming operation(s)`
                    }
                    aria-label={
                      upcoming.needsConfirmCount > 0
                        ? `${upcoming.needsConfirmCount} upcoming operations need confirmation`
                        : `${upcoming.notable.length} upcoming operations`
                    }
                  >
                    {upcoming.needsConfirmCount > 0 ? "!" : upcoming.notable.length}
                  </span>
                )}
                {n.to === "/admin" && steamWebApiMissing && (
                  <span
                    className="nav-alert"
                    title="Steam Web API key not set — workshop titles and deps may be incomplete"
                    aria-label="Steam Web API key not set"
                  >
                    !
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
        <ActiveActionsPanel />
        <div className="sidebar-foot">
          <div className="small muted">{user?.email}</div>
          <FirstMissionGuideNavButton />
          <button className="btn ghost small" onClick={() => logout()}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <UpcomingScheduleBanner
          notable={upcoming.notable}
          now={upcoming.now}
          onReload={upcoming.reload}
        />
        <div className="content-body">{children}</div>
      </main>
      <FirstMissionGuideListener />
    </div>
  );
}

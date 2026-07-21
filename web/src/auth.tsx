import React, { createContext, useContext, useEffect, useState } from "react";
import { api, setCsrf, User, Grant } from "./api";

interface AuthState {
  user: User | null;
  grants: Grant[];
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);

export function useAuth() {
  return useContext(Ctx);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const me = await api.get<{ user: User; csrfToken: string; grants: Grant[] }>("/auth/me");
      setCsrf(me.csrfToken);
      setUser(me.user);
      setGrants(me.grants || []);
    } catch {
      setUser(null);
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function logout() {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    setUser(null);
    setGrants([]);
  }

  function can(permission: string) {
    return grants.some((g) => g.permission === permission);
  }

  return (
    <Ctx.Provider value={{ user, grants, loading, logout, refresh, can }}>
      {children}
    </Ctx.Provider>
  );
}

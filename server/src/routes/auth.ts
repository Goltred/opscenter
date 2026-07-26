import { Router } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import {
  AuthedRequest,
  SESSION_COOKIE,
  clientIp,
  loadGrants,
  publicUser,
  requireAuth,
} from "../auth/middleware.js";
import { hashSessionId, newToken } from "../auth/password.js";
import { upsertOAuthUser } from "../auth/accounts.js";
import {
  buildAuthorizeUrl,
  buildSteamAuthorizeUrl,
  exchangeCode,
  getOAuth2Provider,
  listPublicProviders,
  newOAuthState,
  steamEnabled,
  verifySteamOpenId,
} from "../auth/oauth.js";

export const authRouter = Router();

const OAUTH_STATE_COOKIE = "a3p_oauth_state";

function setSessionCookie(res: import("express").Response, raw: string) {
  res.cookie(SESSION_COOKIE, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure: !config.devMode,
    path: "/",
    maxAge: config.sessionTtlHours * 3600 * 1000,
  });
}

function createSession(userId: string, req: import("express").Request) {
  const raw = newToken(32);
  const csrf = newToken(24);
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions(id, user_id, csrf_token, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(hashSessionId(raw), userId, csrf, expires, clientIp(req), req.get("user-agent") || "");
  return { raw, csrf };
}

function setOAuthState(res: import("express").Response, state: string) {
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: !config.devMode,
    path: "/",
    maxAge: 10 * 60 * 1000,
  });
}

function clearOAuthState(res: import("express").Response) {
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
}

function frontendRedirect(path: string): string {
  const base = (config.devMode ? config.webOrigin : config.publicUrl).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

authRouter.get("/providers", (_req, res) => {
  res.json({ providers: listPublicProviders() });
});

authRouter.get("/oauth/:provider/start", (req, res) => {
  const providerId = String(req.params.provider || "");
  const state = newOAuthState();
  setOAuthState(res, state);

  if (providerId === "steam") {
    if (!steamEnabled()) return res.status(404).json({ error: "steam oauth not configured (set A3P_OAUTH_STEAM=1)" });
    return res.redirect(buildSteamAuthorizeUrl(state));
  }

  const provider = getOAuth2Provider(providerId);
  if (!provider) return res.status(404).json({ error: "provider not configured" });
  return res.redirect(buildAuthorizeUrl(provider, state));
});

authRouter.get("/oauth/:provider/callback", async (req, res) => {
  const providerId = String(req.params.provider || "");
  const expectedState = String(req.cookies?.[OAUTH_STATE_COOKIE] || "");
  clearOAuthState(res);

  try {
    let identity;
    if (providerId === "steam") {
      const qState = String(req.query.state || "");
      if (!expectedState || qState !== expectedState) {
        return res.redirect(frontendRedirect("/login?error=invalid_state"));
      }
      identity = await verifySteamOpenId(req.query as Record<string, unknown>);
    } else {
      const state = String(req.query.state || "");
      const code = String(req.query.code || "");
      if (!expectedState || state !== expectedState || !code) {
        return res.redirect(frontendRedirect("/login?error=invalid_state"));
      }
      const provider = getOAuth2Provider(providerId);
      if (!provider) return res.redirect(frontendRedirect("/login?error=provider"));
      const accessToken = await exchangeCode(provider, code);
      identity = await provider.profile(accessToken);
    }

    const { userId, approved } = upsertOAuthUser(identity);
    const user = getDb().prepare("SELECT * FROM users WHERE id = ?").get(userId) as { disabled: number } | undefined;
    if (!user || user.disabled) return res.redirect(frontendRedirect("/login?error=disabled"));

    const { raw } = createSession(userId, req);
    setSessionCookie(res, raw);
    if (!approved) return res.redirect(frontendRedirect("/pending"));
    return res.redirect(frontendRedirect("/"));
  } catch (e) {
    console.error("oauth callback failed", e);
    return res.redirect(frontendRedirect("/login?error=oauth_failed"));
  }
});

authRouter.post("/login", (_req, res) => {
  res.status(410).json({ error: "password login disabled — use OAuth providers" });
});

authRouter.post("/logout", requireAuth, (req: AuthedRequest, res) => {
  if (req.session) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ status: "ok" });
});

authRouter.get("/me", requireAuth, (req: AuthedRequest, res) => {
  res.json({
    user: publicUser(req.user!),
    csrfToken: req.session!.csrf_token,
    grants: req.user!.approved ? req.grants || loadGrants(req.user!.id) : [],
  });
});

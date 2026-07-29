import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { BrandMark } from "../components/BrandMark";
import { ProviderIcon } from "../components/ProviderIcons";
import { PRODUCT_BRAND } from "../theme/catalog";

type Provider = { id: string; label: string; enabled: boolean };

const ERRORS: Record<string, string> = {
  invalid_state: "Sign-in session expired. Try again.",
  provider: "That provider is not configured on the server.",
  disabled: "Your account is disabled.",
  oauth_failed: "Sign-in failed. Check provider credentials and try again.",
};

export function Login() {
  const [params] = useSearchParams();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const err = ERRORS[params.get("error") || ""] || (params.get("error") ? "Sign-in failed." : "");

  useEffect(() => {
    api
      .get<{ providers: Provider[] }>("/auth/providers")
      .then((r) => setProviders(r.providers || []))
      .catch(() => setProviders([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <BrandMark />
        <div className="muted small" style={{ marginTop: 6 }}>
          {PRODUCT_BRAND.tagline}
        </div>
        <div className="muted small">Sign in with an account provider. New accounts wait for admin approval.</div>
        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
        {loading ? (
          <div className="muted" style={{ marginTop: 16 }}>Loading providers…</div>
        ) : providers.length === 0 ? (
          <div className="warn" style={{ marginTop: 16 }}>
            No OAuth providers configured. Use the installer / <code>deploy/oauth-bootstrap.json</code>, or Admin → Sign-in (see docs/INSTALL.md).
          </div>
        ) : (
          <div className="oauth-providers">
            {providers.map((p) => (
              <a
                key={p.id}
                className={`oauth-btn oauth-btn--${p.id}`}
                href={`/api/auth/oauth/${p.id}/start`}
              >
                <span className="oauth-btn-icon"><ProviderIcon id={p.id} size={22} /></span>
                <span>Continue with {p.label}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getSessionManager } from "../session-context.js";
import type { LoginFlows } from "@linnet/core";

interface Props {
  defaultHomeserver?: string;
  onSignedIn: () => void;
  /** W8 seam: where the browser is sent for the SSO bounce (testable). */
  navigate?: (url: string) => void;
  /** W8 seam: current URL carrying ?loginToken= after the IdP relay bounces back. */
  search?: string;
  /** W8 seam: strip loginToken from the URL after consumption. */
  onTokenConsumed?: () => void;
}

export function Login({
  defaultHomeserver = "https://matrix.org",
  onSignedIn,
  navigate = (url: string) => window.location.assign(url),
  search,
  onTokenConsumed,
}: Props): ReactNode {
  const [homeserver, setHomeserver] = useState(defaultHomeserver);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flows, setFlows] = useState<LoginFlows | null>(null);
  const [tokenState, setTokenState] = useState<"idle" | "working" | "failed">("idle");

  const query = search ?? (typeof window !== "undefined" ? window.location.search : "");
  const loginToken = new URLSearchParams(query).get("loginToken");

  // W8 SSO return leg: the IdP relay bounced us back with ?loginToken=.
  useEffect(() => {
    if (!loginToken || tokenState !== "idle") return;
    setTokenState("working");
    getSessionManager()
      .loginWithSsoToken(homeserver, loginToken)
      .then(() => {
        onTokenConsumed?.();
        onSignedIn();
      })
      .catch((err: unknown) => {
        setTokenState("failed");
        setError(err instanceof Error ? err.message : "SSO token login failed");
        onTokenConsumed?.();
      });
  }, [loginToken, tokenState, homeserver, onSignedIn, onTokenConsumed]);

  // Flow discovery: show the right buttons for this homeserver.
  useEffect(() => {
    let dead = false;
    setFlows(null);
    getSessionManager()
      .discoverLogin(homeserver)
      .then((f) => !dead && setFlows(f))
      .catch(() => !dead && setFlows({ password: true, sso: false, identityProviders: [] }));
    return () => {
      dead = true;
    };
  }, [homeserver]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await getSessionManager().login({ homeserverUrl: homeserver, username, password });
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  async function sso(idpId?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const here = `${window.location.origin}${window.location.pathname}`;
      const url = await getSessionManager().getSsoLoginUrl(homeserver, here, idpId);
      navigate(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "SSO unavailable");
    } finally {
      setBusy(false);
    }
  }

  if (loginToken && tokenState !== "idle") {
    return (
      <form className="login" onSubmit={(e) => e.preventDefault()}>
        <h2>Completing sign-in…</h2>
        {error && <p className="error" role="alert">{error}</p>}
        {error && (
          <button type="button" onClick={() => window.location.reload()}>Try again</button>
        )}
      </form>
    );
  }

  const showPassword = !flows || flows.password;
  const idps = flows?.identityProviders ?? [];

  return (
    <form className="login" onSubmit={(e) => void submit(e)}>
      <h2>Sign in to Linnet</h2>
      <label>
        Homeserver
        <input value={homeserver} onChange={(e) => setHomeserver(e.target.value)} name="homeserver" />
      </label>

      {flows?.sso && (
        <div className="sso-block">
          {idps.length > 0 ? (
            idps.map((idp) => (
              <button
                key={idp.id}
                type="button"
                className="sso"
                disabled={busy}
                onClick={() => void sso(idp.id)}
              >
                Continue with {idp.name}
              </button>
            ))
          ) : (
            <button type="button" className="sso" disabled={busy} onClick={() => void sso()}>
              Continue with single sign-on
            </button>
          )}
          {showPassword && <div className="or-divider" aria-hidden="true">or</div>}
        </div>
      )}

      {showPassword && (
        <>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} name="username" autoComplete="username" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              name="password"
              autoComplete="current-password"
            />
          </label>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {showPassword && (
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      )}
    </form>
  );
}

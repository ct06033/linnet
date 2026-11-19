import { useState, type FormEvent, type ReactNode } from "react";
import { getSessionManager } from "../session-context.js";

interface Props {
  defaultHomeserver?: string;
  onSignedIn: () => void;
}

export function Login({ defaultHomeserver = "https://matrix.org", onSignedIn }: Props): ReactNode {
  const [homeserver, setHomeserver] = useState(defaultHomeserver);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <form className="login" onSubmit={(e) => void submit(e)}>
      <h2>Sign in to Linnet</h2>
      <label>
        Homeserver
        <input value={homeserver} onChange={(e) => setHomeserver(e.target.value)} name="homeserver" />
      </label>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} name="username" />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          name="password"
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !username || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="sso-note">SSO / OIDC arrives with wave 3 (UIAA). SaaS-free by design.</p>
    </form>
  );
}

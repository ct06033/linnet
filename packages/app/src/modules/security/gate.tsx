/**
 * W21 item 2: the mandatory security gate (Sean: "make that mandatory").
 *
 * While a session is live but the account is not fully protected, this
 * overlay blocks the app until ONE of:
 *   setup   — brand-new account: user sets the SECURITY PASSPHRASE, we
 *             bootstrap cross-signing + SSSS + key backup with it, then show
 *             the recovery key exactly once with forced acknowledgment;
 *   unlock  — account already has SSSS (another device set it up): the
 *             passphrase unlocks this device's copy of the keys so existing
 *             encrypted history decrypts immediately (recovery key accepted
 *             as the fallback route).
 * There is deliberately NO dismiss path — only completion, or sign out from
 * an error step. Once a device passes, the probe flips to ready and the gate
 * never re-appears for it (state lives on the server, not locally).
 */
import { useCallback, useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { SecurityAdapter } from "./Security.js";
import type { SecurityStatus } from "./state.js";

type Mode = "probing" | "none" | "setup" | "unlock" | "working" | "showKey" | "error";

/**
 * W22 (Sean prod): the gate/security center must NEVER surface raw SDK crypto
 * error strings ("Error decrypting secret m.megolm_backup.v1: bad MAC" leaked
 * verbatim in 0.2.4). Map decryption failures to actionable copy; everything
 * else (login-password/UIA honesty etc.) passes through untouched.
 */
export function mapSecretStorageError(message: string): string {
  if (/bad MAC|could not decrypt/i.test(message)) {
    return "That key doesn't match any copy of your secrets on this account. Try the other option (passphrase ↔ recovery key), or your login password if that's what you set as your security passphrase.";
  }
  return message;
}

export interface GateProps {
  client: MatrixClient | null;
  adapter: SecurityAdapter;
  /** wired from App; used by the only escape hatch (error steps) */
  onSignOut: () => void;
}

export function SecurityGate(props: GateProps): JSX.Element | null {
  const { client, adapter, onSignOut } = props;
  const [mode, setMode] = useState<Mode>("probing");
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  // setup fields
  const [password, setPassword] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  // unlock fields
  const [route, setRoute] = useState<"passphrase" | "key">("passphrase");
  const [secret, setSecret] = useState("");
  const [imported, setImported] = useState(0);
  // flow results
  const [recoveryKey, setRecoveryKey] = useState("");
  const [message, setMessage] = useState("");

  const probe = useCallback(async () => {
    if (!client) {
      setMode("none");
      return;
    }
    setMode("probing");
    try {
      const s = await adapter.status(client);
      setStatus(s);
      if (!s.cryptoAvailable || s.ready) setMode("none");
      else setMode(s.ssssReady ? "unlock" : "setup");
    } catch {
      // Probe failure must not strand the user in a modal we can't resolve:
      // stay quiet; the security center still covers manual setup.
      setMode("none");
    }
  }, [client, adapter]);

  useEffect(() => {
    void probe();
  }, [probe]);

  if (!client || mode === "probing" || mode === "none") return null;

  const startWorking = (what: string) => {
    setMessage(what);
    setMode("working");
  };

  async function doSetup(): Promise<void> {
    if (!client) return;
    if (!password) return;
    if (pass1.length < 8) {
      setMessage("The passphrase needs at least 8 characters.");
      setMode("error");
      return;
    }
    if (pass1 !== pass2) {
      setMessage("The two passphrases don't match — check for a typo.");
      setMode("error");
      return;
    }
    startWorking("Setting up encryption keys — this runs once, on this account…");
    try {
      const key = await adapter.bootstrap({ client, userId: client.getUserId() ?? "", password, passphrase: pass1 });
      setRecoveryKey(key);
      setPassword("");
      setPass1("");
      setPass2("");
      setMode("showKey");
    } catch (err) {
      const m = (err as Error).message || String(err);
      // 11-24 (Sean prod): when the account ALREADY has keys (Element set them
      // up first), setup is a dead end — route straight to the unlock screen
      // with a visible explanation instead of a generic error.
      if (/already has/i.test(m)) {
        setStatus((s) => (s ? { ...s, ssssReady: true } : s));
        setMessage("Your account already has encryption keys from another app (e.g. Element). Enter the passphrase or recovery key you use THERE to unlock this device — or set a new passphrase from inside that app first.");
        setRoute("passphrase");
        setMode("unlock");
        return;
      }
      setMessage(`Setup failed: ${mapSecretStorageError(m)}`);
      setMode("error");
    }
  }

  async function doUnlock(): Promise<void> {
    if (!client || !secret) return;
    startWorking("Unlocking your keys — downloading and decrypting the history backup…");
    try {
      const n = await adapter.unlock({
        client,
        secret: route === "passphrase" ? { passphrase: secret } : { recoveryKey: secret },
        onProgress: (p) => {
          if (typeof p.imported === "number") setImported(p.imported);
          if (typeof p.total === "number") setMessage(`Decrypting keys… ${p.imported ?? 0}/${p.total}`);
        },
      });
      setImported(n);
      setSecret("");
      await probe(); // -> ready -> gate closes
    } catch (err) {
      setMessage(`Unlock failed: ${mapSecretStorageError((err as Error).message || String(err))}. You can retry or sign out.`);
      setMode("error");
    }
  }

  return (
    <div className="dialog-scrim" data-testid="security-gate">
      <div className="dialog gate-dialog" role="dialog" aria-modal="true" aria-label="Security setup">
        {mode === "setup" && (
          <>
            <h3>Set your security passphrase</h3>
            <p className="gate-copy">
              Linnet encrypts your conversations end-to-end. This passphrase protects your message history so you can
              read it on every device you sign in to. It is required once per account — and once per new device.
            </p>
            <label className="gate-field">
              Account password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <label className="gate-field">
              Security passphrase (min 8 characters)
              <input type="password" value={pass1} onChange={(e) => setPass1(e.target.value)} autoComplete="new-password" />
            </label>
            <label className="gate-field">
              Confirm passphrase
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
            </label>
            <button className="primary" onClick={() => void doSetup()} disabled={!password || !pass1 || !pass2}>
              Protect my messages
            </button>
          </>
        )}
        {mode === "unlock" && (
          <>
            <h3>Unlock your encrypted history</h3>
            {message && (
              <p className="gate-copy" role="status" data-testid="gate-hint">{message}</p>
            )}
            <p className="gate-copy">
              Your messages are protected by your security passphrase. Enter it to decrypt your conversations on this
              device — history that used to show “unable to decrypt” will open immediately.
            </p>
            <label className="gate-field">
              {route === "passphrase" ? "Security passphrase" : "Recovery key"}
              <input
                type={route === "passphrase" ? "password" : "text"}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {route === "key" && (
              <p className="gate-copy">
                Groups of 4 characters starting with E, copied from Element: Settings → Security &amp; Privacy → Recovery Key.
              </p>
            )}
            <button className="linkbtn" onClick={() => { setMessage(""); setRoute(route === "passphrase" ? "key" : "passphrase"); }}>
              {route === "passphrase" ? "Use a recovery key instead" : "Use the passphrase instead"}
            </button>
            <div className="gate-actions">
              <button className="primary" onClick={() => void doUnlock()} disabled={!secret}>
                Unlock my history
              </button>
              <button onClick={() => { setMessage(""); setMode("setup"); }}>Set a new passphrase…</button>
            </div>
          </>
        )}
        {mode === "working" && (
          <>
            <h3>Working…</h3>
            <p className="gate-copy">{message || "One moment."}</p>
          </>
        )}
        {mode === "showKey" && (
          <>
            <h3>Save your recovery key</h3>
            <p className="gate-copy">
              This is the LAST chance to see it — it works instead of the passphrase if you ever forget it. Copy it
              somewhere safe (a password manager is ideal).
            </p>
            <textarea className="gate-key" readOnly value={recoveryKey} rows={3} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="primary"
              onClick={() => {
                setRecoveryKey("");
                void probe();
              }}
            >
              I saved it — finish
            </button>
          </>
        )}
        {mode === "error" && (
          <>
            <h3>Couldn’t continue</h3>
            <p className="gate-copy">{message}</p>
            <div className="gate-actions">
              <button className="primary" onClick={() => void probe()}>
                Try again
              </button>
              <button onClick={onSignOut}>Sign out</button>
            </div>
          </>
        )}
        {status && mode === "unlock" && imported > 0 && <p className="gate-copy">keys imported: {imported}</p>}
      </div>
    </div>
  );
}

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
import { describeSecurityAccountText, type SecurityAccountDescription } from "@linnet/core";
import type { SecurityAdapter } from "./Security.js";
import type { SecurityStatus } from "./state.js";

type Mode = "probing" | "none" | "setup" | "unlock" | "working" | "showKey" | "error" | "reset" | "rotate";

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
  // unlock fields — W23-A adds the "loginpw" route (try the ACCOUNT PASSWORD
  // as the security passphrase; same core path, no new core code)
  const [route, setRoute] = useState<"passphrase" | "key" | "loginpw">("passphrase");
  const [secret, setSecret] = useState("");
  const [imported, setImported] = useState(0);
  // W23-D: unlock attempts + account diagnostics disclosure
  const [unlockFailures, setUnlockFailures] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
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
    const wasLoginPw = route === "loginpw";
    startWorking("Unlocking your keys — downloading and decrypting the history backup…");
    try {
      const n = await adapter.unlock({
        client,
        secret: route === "passphrase" ? { passphrase: secret } : route === "loginpw" ? { passphrase: secret } : { recoveryKey: secret },
        onProgress: (p) => {
          if (typeof p.imported === "number") setImported(p.imported);
          if (typeof p.total === "number") setMessage(`Decrypting keys… ${p.imported ?? 0}/${p.total}`);
        },
      });
      setImported(n);
      setSecret("");
      setUnlockFailures(0);
      await probe(); // -> ready -> gate closes
    } catch (err) {
      // W23-A honesty note: login passwords are NEVER kept in state/UI after a
      // failed attempt (no prefill); W23-D: two failures auto-reveal the
      // account diagnostics.
      if (wasLoginPw) setSecret("");
      const f = unlockFailures + 1;
      setUnlockFailures(f);
      if (f >= 2) setShowDiagnostics(true);
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
            {route !== "loginpw" && (
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
            )}
            {route === "key" && (
              <p className="gate-copy">
                Groups of 4 characters starting with E, copied from Element: Settings → Security &amp; Privacy → Recovery Key.
              </p>
            )}
            {route === "loginpw" && (
              <>
                <label className="gate-field">
                  Account login password
                  <input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    autoComplete="current-password"
                    data-testid="unlock-loginpw-input"
                  />
                </label>
                <p className="gate-copy">
                  If you accepted Element&apos;s old suggestion to reuse your login password as your security
                  passphrase, this unlocks it. Linnet never stores this password.
                </p>
              </>
            )}
            <button className="linkbtn" onClick={() => { setMessage(""); setSecret(""); setRoute(route === "passphrase" ? "key" : "passphrase"); }}>
              {route === "passphrase" ? "Use a recovery key instead" : "Use the passphrase instead"}
            </button>
            {/* W23-A: third affordance — many Element users took the old
                default of passphrase == account password. Same core path
                (unlock with the typed password as the passphrase); the
                password is NEVER stored or prefilled. */}
            {route !== "loginpw" && (
              <button
                className="linkbtn"
                data-testid="try-login-password"
                onClick={() => { setMessage(""); setSecret(""); setRoute("loginpw"); }}
              >
                Try my account login password
              </button>
            )}
            <div className="gate-actions">
              <button className="primary" onClick={() => void doUnlock()} disabled={!secret}>
                Unlock my history
              </button>
              <button onClick={() => { setMessage(""); setMode("setup"); }}>Set a new passphrase…</button>
            </div>
            <div className="gate-links">
              {/* W23-B entry — DESTRUCTIVE, confirm-gated in ResetSecurityPanel */}
              <button
                className="linkbtn danger"
                data-testid="reset-entry"
                onClick={() => { setMessage(""); setMode("reset"); }}
              >
                Forgot both? Reset your security access
              </button>
              {/* W24 entry — NON-destructive rotation: prove the current key,
                  set a new passphrase, history decrypts, identity is kept.
                  Always available here (Sean: users hit the wall on attempt 1). */}
              <button
                className="linkbtn"
                data-testid="rotate-entry"
                onClick={() => { setMessage(""); setMode("rotate"); }}
              >
                Lost your passphrase? Rotate your recovery method
              </button>
              {/* W23-D: always-available disclosure (auto-opens after 2 failures) */}
              <button className="linkbtn" data-testid="show-diagnostics" onClick={() => setShowDiagnostics((v) => !v)}>
                {showDiagnostics ? "Hide account details" : "What does my account have? Show details"}
              </button>
            </div>
            {showDiagnostics && <SecurityDiagnostics client={client} adapter={adapter} />}
          </>
        )}
        {mode === "reset" && client && (
          <ResetSecurityPanel
            client={client}
            adapter={adapter}
            onDone={() => void probe()} // -> ready -> gate closes
            onCancel={() => { setMessage(""); setMode("unlock"); }}
          />
        )}
        {mode === "rotate" && client && (
          <RotateSecurityPanel
            client={client}
            adapter={adapter}
            onDone={() => void probe()} // -> ready -> gate closes
            onCancel={() => { setMessage(""); setMode("unlock"); }}
          />
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
            {/* W23-D: after two failures the diagnostics stay open here too */}
            {showDiagnostics && client && <SecurityDiagnostics client={client} adapter={adapter} />}
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

/**
 * W23-D — "What your account actually has". Renders the core
 * describeSecurityAccount view: actionable headline (mapped by the W23 rules
 * in core), per-key + per-secret list, backup version, the W22 stale-entry
 * note, and a plain-text "Copy details" affordance for support. Key ids are
 * PUBLIC account data — shown in full; ciphertext/iv/mac are never read by
 * core and never rendered here.
 */
export function SecurityDiagnostics(props: { client: MatrixClient; adapter: SecurityAdapter }): JSX.Element {
  const [d, setD] = useState<SecurityAccountDescription | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let dead = false;
    setD(null);
    setFailed(false);
    props.adapter
      .describeAccount(props.client)
      .then((x) => !dead && setD(x))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, [props.adapter, props.client]);

  if (failed) {
    return <p className="gate-copy" data-testid="diag-failed">Account details unavailable right now — your connection may be down.</p>;
  }
  if (!d) {
    return <p className="gate-copy" data-testid="diag-loading">Reading your account…</p>;
  }

  async function copy(): Promise<void> {
    if (!d) return;
    try {
      await navigator.clipboard?.writeText(describeSecurityAccountText(d));
      setCopied(true);
    } catch {
      // clipboard blocked (permissions/insecure context) — the on-screen
      // list still carries everything support needs
    }
  }

  return (
    <div className="sec-diag hc" data-contrast="wcag" data-position="center" data-testid="security-diagnostics">
      <p className="gate-copy diag-headline" data-testid="diag-headline"><b>{d.headline}</b></p>
      {d.notes.map((n, i) => (
        <p key={i} className="gate-copy diag-note" data-testid="diag-note">{n}</p>
      ))}
      <ul className="diag-list" data-testid="diag-keys">
        {d.keys.length === 0 && <li>No security keys found on this account.</li>}
        {d.keys.map((k) => (
          <li key={k.keyId} data-testid={`diag-key-${k.keyId}`}>
            <code>{k.keyId}</code>
            {k.isDefault ? " (current default)" : ""} —{" "}
            {k.passphraseDerived
              ? `passphrase-derived (PBKDF2, ${k.pbkdf2Iterations ?? "?"} iterations)`
              : "generated recovery key"}
            {k.name ? ` · name: ${k.name}` : ""}
            {k.guardsSecrets.length === 0 ? " · guards nothing now" : ""}
          </li>
        ))}
      </ul>
      <ul className="diag-list" data-testid="diag-secrets">
        {d.secrets.map((s) => (
          <li key={s.name} data-testid={`diag-secret-${s.name}`}>
            {s.name}: {s.exists ? `stored under ${s.keyIds.join(", ")}` : "not stored"}
          </li>
        ))}
      </ul>
      <p className="gate-copy" data-testid="diag-backup">
        {d.backup.exists
          ? `Key backup: version ${d.backup.version}, ${d.backup.count ?? "?"} keys backed up.`
          : "Key backup: none on the server."}
      </p>
      <button className="linkbtn" data-testid="diag-copy" onClick={() => void copy()}>
        {copied ? "Copied ✓" : "Copy details for support"}
      </button>
    </div>
  );
}

/**
 * W23-B — the DESTRUCTIVE "reset security access" flow for accounts whose
 * passphrase AND recovery key are both gone. Honest impact list FIRST, an
 * "I understand" checkbox gating the form (account password + new passphrase
 * min 8 + confirm), then core resetSecurityAccess via the adapter; success
 * lands in the W21 forced-ack recovery-key view and onDone re-probes the
 * gate. BANNED framing: this never promises the old history comes back —
 * nothing protected by the lost key is recoverable, and we say so.
 *
 * Error honesty (b28e991 rule): wrong-password / UIA rejections show the
 * server's own message VERBATIM (only mapSecretStorageError's decryption
 * family gets reworded); no "reset failed" wrapper ever eats those words.
 */
export function ResetSecurityPanel(props: {
  client: MatrixClient;
  adapter: SecurityAdapter;
  onDone: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const [step, setStep] = useState<"confirm" | "form" | "working" | "showKey" | "error">("confirm");
  const [ack, setAck] = useState(false);
  const [password, setPassword] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [message, setMessage] = useState("");

  const formReady = ack && password.length > 0 && pass1.length >= 8 && pass1 === pass2;

  async function go(): Promise<void> {
    if (!formReady) return;
    setStep("working");
    try {
      const r = await props.adapter.resetSecurity({
        client: props.client,
        userId: props.client.getUserId() ?? "",
        password,
        passphrase: pass1,
      });
      // nothing sensitive kept in state beyond the one-time key view
      setPassword("");
      setPass1("");
      setPass2("");
      setRecoveryKey(r.recoveryKey);
      setStep("showKey");
    } catch (err) {
      setPassword("");
      setPass1("");
      setPass2("");
      const m = (err as Error).message || String(err);
      setMessage(mapSecretStorageError(m)); // auth/UIA messages survive verbatim
      setStep("error");
    }
  }

  if (step === "confirm") {
    return (
      <div className="reset-panel" data-testid="reset-confirm">
        <h3>Reset your security access</h3>
        <p className="gate-copy">
          Forgot both your passphrase and your recovery key? A reset starts a brand-new security setup on your
          account. Read what this does first:
        </p>
        <ul className="gate-list" data-testid="reset-impact">
          <li>Old message history that lives in your previous encrypted backup will NOT be recoverable — its key was protected by the passphrase you lost.</li>
          <li>New messages going forward will be backed up with the new key.</li>
          <li>Your other sessions (e.g. Element on other machines) will show a one-time “identity changed / session not verified” warning until you re-verify or sign them out; contacts see a new-identity shield once.</li>
          <li>Requires your account password.</li>
        </ul>
        <label className="gate-check" data-testid="reset-understand-label">
          <input
            type="checkbox"
            aria-label="I understand"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="reset-understand"
          />
          I understand
        </label>
        <div className="gate-actions">
          <button className="primary" disabled={!ack} onClick={() => setStep("form")} data-testid="reset-continue">
            Continue
          </button>
          {props.onCancel && <button onClick={props.onCancel} data-testid="reset-cancel">Back</button>}
        </div>
      </div>
    );
  }

  if (step === "form") {
    return (
      <div className="reset-panel" data-testid="reset-form">
        <h3>Reset your security access</h3>
        <label className="gate-field">
          Account password
          <input
            type="password"
            aria-label="Account password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            data-testid="reset-password"
          />
        </label>
        <label className="gate-field">
          New security passphrase (min 8 characters)
          <input
            type="password"
            aria-label="New security passphrase"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
            autoComplete="new-password"
            data-testid="reset-pass1"
          />
        </label>
        <label className="gate-field">
          Confirm new passphrase
          <input
            type="password"
            aria-label="Confirm new passphrase"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            autoComplete="new-password"
            data-testid="reset-pass2"
          />
        </label>
        <div className="gate-actions">
          <button className="primary danger" disabled={!formReady} onClick={() => void go()} data-testid="reset-go">
            Reset security access
          </button>
          <button onClick={() => { setMessage(""); setStep("confirm"); }} data-testid="reset-back">Back</button>
        </div>
      </div>
    );
  }

  if (step === "working") {
    return (
      <div className="reset-panel" data-testid="reset-working">
        <h3>Resetting…</h3>
        <p className="gate-copy">
          Rotating your security key, creating a new signing identity and starting a fresh backup. This runs once —
          don&apos;t close the window.
        </p>
      </div>
    );
  }

  if (step === "showKey") {
    return (
      <div className="reset-panel" data-testid="reset-showkey">
        <h3>Save your new recovery key</h3>
        <p className="gate-copy">
          This is the LAST chance to see it — it works instead of the new passphrase if you ever forget it. Copy it
          somewhere safe (a password manager is ideal).
        </p>
        <textarea className="gate-key" readOnly value={recoveryKey} rows={3} onFocus={(e) => e.currentTarget.select()} />
        <button
          className="primary"
          data-testid="reset-ack"
          onClick={() => {
            setRecoveryKey("");
            props.onDone();
          }}
        >
          I saved it — finish
        </button>
      </div>
    );
  }

  // error step — server honesty first: the message is displayed as-is
  return (
    <div className="reset-panel" data-testid="reset-error">
      <h3>Couldn’t complete the reset</h3>
      <p className="gate-copy" role="status" data-testid="reset-error-message">{message}</p>
      <div className="gate-actions">
        <button className="primary" onClick={() => setStep("form")} data-testid="reset-retry">Try again</button>
        {props.onCancel && <button onClick={props.onCancel} data-testid="reset-cancel">Back</button>}
      </div>
    </div>
  );
}

/**
 * W24 ROUTE E — the NON-destructive recovery-method rotation (Sean's exact
 * flow, verbatim intent): confirm the CURRENT RECOVERY KEY (Element's key;
 * the passphrase is the same door via the toggle) → choose a NEW security
 * passphrase → Linnet rotates 4S, RE-WRAPS every secret under the new key,
 * decrypts this device's history NOW and keeps the cross-signing identity.
 * The old credential stops working for 4S fetches afterwards — the copy says
 * exactly that (banned: "recover" framing, any promise of old-key access).
 *
 * Steps: prove → passphrase → working → forced-ack of the NEW key → done.
 * Edge H (master never stored in 4S — pre-SSSS Element accounts): core still
 * completes; the key view adds the honest verify-elsewhere note.
 * Error honesty (b28e991): only the decryption family is reworded via
 * mapSecretStorageError; server/UIA-shaped strings stay verbatim. Credentials
 * are cleared from state on failure (W23-A rule).
 */
export function RotateSecurityPanel(props: {
  client: MatrixClient;
  adapter: SecurityAdapter;
  onDone: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const [step, setStep] = useState<"prove" | "passphrase" | "working" | "showKey" | "error">("prove");
  const [proofRoute, setProofRoute] = useState<"key" | "passphrase">("key");
  const [proof, setProof] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [edgeH, setEdgeH] = useState(false);
  const [imported, setImported] = useState(0);
  const [message, setMessage] = useState("");

  const proofReady = proof.trim().length > 0;
  const passReady = pass1.length >= 8 && pass1 === pass2;

  async function go(): Promise<void> {
    if (!proofReady || !passReady) return;
    setStep("working");
    try {
      const r = await props.adapter.rotateRecovery({
        client: props.client,
        userId: props.client.getUserId() ?? "",
        secret: proofRoute === "passphrase" ? { passphrase: proof } : { recoveryKey: proof },
        passphrase: pass1,
        onProgress: (p) => {
          if (typeof p.imported === "number") setImported(p.imported);
        },
      });
      // no sensitive input kept in state after success — only the one-time key
      setProof("");
      setPass1("");
      setPass2("");
      setEdgeH(!r.masterSecretWasStored);
      setRecoveryKey(r.recoveryKey);
      setStep("showKey");
    } catch (err) {
      setProof("");
      setPass1("");
      setPass2("");
      setMessage(mapSecretStorageError((err as Error).message || String(err)));
      setStep("error");
    }
  }

  if (step === "prove") {
    return (
      <div className="rotate-panel" data-testid="rotate-prove">
        <h3>Confirm your current recovery key</h3>
        <p className="gate-copy">
          Rotating your recovery method keeps your message history and your verification identity — it only changes
          the credential that protects them. Proof first: enter what you use TODAY.
        </p>
        <label className="gate-field">
          {proofRoute === "key" ? "Current recovery key" : "Current security passphrase"}
          <input
            // recovery key UNMASKED with normalization rules per W21 hotfix;
            // passphrase masked like every other passphrase field
            type={proofRoute === "key" ? "text" : "password"}
            aria-label={proofRoute === "key" ? "Current recovery key" : "Current security passphrase"}
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="rotate-proof"
          />
        </label>
        {proofRoute === "key" && (
          <p className="gate-copy" data-testid="rotate-key-hint">
            Groups of 4 characters starting with E, copied from Element: Settings → Security &amp; Privacy → Recovery Key.
          </p>
        )}
        <button
          className="linkbtn"
          data-testid="rotate-proof-toggle"
          onClick={() => {
            setProof("");
            setProofRoute(proofRoute === "key" ? "passphrase" : "key");
          }}
        >
          {proofRoute === "key" ? "Use my passphrase instead" : "Use my recovery key instead"}
        </button>
        <div className="gate-actions">
          <button className="primary" disabled={!proofReady} onClick={() => setStep("passphrase")} data-testid="rotate-prove-next">
            Continue
          </button>
          {props.onCancel && <button onClick={props.onCancel} data-testid="rotate-cancel">Back</button>}
        </div>
      </div>
    );
  }

  if (step === "passphrase") {
    return (
      <div className="rotate-panel" data-testid="rotate-passphrase">
        <h3>Choose your new security passphrase</h3>
        <p className="gate-copy">
          From now on this passphrase (or the new recovery key you’ll be shown once) unlocks your history on every
          device. Your current credential stops working for future logins — nothing else changes.
        </p>
        <label className="gate-field">
          New security passphrase (min 8 characters)
          <input
            type="password"
            aria-label="New security passphrase"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
            autoComplete="new-password"
            data-testid="rotate-pass1"
          />
        </label>
        <label className="gate-field">
          Confirm new passphrase
          <input
            type="password"
            aria-label="Confirm new passphrase"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            autoComplete="new-password"
            data-testid="rotate-pass2"
          />
        </label>
        <div className="gate-actions">
          <button className="primary" disabled={!passReady} onClick={() => void go()} data-testid="rotate-go">
            Rotate &amp; decrypt my history
          </button>
          <button onClick={() => { setMessage(""); setStep("prove"); }} data-testid="rotate-back">Back</button>
        </div>
      </div>
    );
  }

  if (step === "working") {
    return (
      <div className="rotate-panel" data-testid="rotate-working">
        <h3>Rotating your recovery method</h3>
        <p className="gate-copy">
          Rotating keys and decrypting your history… {imported > 0 ? `${imported} message keys imported.` : ""} This
          runs once — don’t close the window.
        </p>
      </div>
    );
  }

  if (step === "showKey") {
    return (
      <div className="rotate-panel" data-testid="rotate-showkey">
        <h3>Save your NEW recovery key</h3>
        <p className="gate-copy">
          The old recovery key and passphrase no longer work for future logins — this is the only time the new key is
          shown. Copy it somewhere safe (a password manager is ideal). Your history and your verification identity are
          unchanged.
        </p>
        {edgeH && (
          <p className="gate-copy" data-testid="rotate-edgeh">
            Your identity keys were never stored in your recovery setup — the new passphrase works for history now; to
            verify this device, use Element&apos;s cross-verification, or full Reset in Linnet.
          </p>
        )}
        <textarea className="gate-key" readOnly value={recoveryKey} rows={3} onFocus={(e) => e.currentTarget.select()} data-testid="rotate-newkey" />
        <button
          className="primary"
          data-testid="rotate-ack"
          onClick={() => {
            setRecoveryKey("");
            props.onDone();
          }}
        >
          I saved it — finish
        </button>
      </div>
    );
  }

  // error step — only the decryption family is reworded; server strings verbatim
  return (
    <div className="rotate-panel" data-testid="rotate-error">
      <h3>Couldn’t rotate</h3>
      <p className="gate-copy" role="status" data-testid="rotate-error-message">{message}</p>
      <div className="gate-actions">
        <button className="primary" onClick={() => { setMessage(""); setStep("prove"); }} data-testid="rotate-retry">Try again</button>
        {props.onCancel && <button onClick={props.onCancel} data-testid="rotate-cancel">Back</button>}
      </div>
    </div>
  );
}

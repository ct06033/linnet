/**
 * linnet.security UI — banner chip, setup wizard, recovery flow, back-up-now.
 * All side effects go through the SecurityAdapter so jsdom tests run without
 * rust crypto; the prod adapter delegates to @linnet/core/e2ee (already
 * HS-A-proven lifecycle functions).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { SasPanel, SessionsSection } from "./sessions.js";

export interface SasEntry {
  emoji?: string[];
  description: string;
}
export type VerifyHandle = {
  entries(): Promise<SasEntry[]>;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
  finished(): Promise<"done" | "cancelled">;
};
export type SessionRow = {
  deviceId: string;
  name: string;
  lastSeen?: string;
  ip?: string;
  verified: boolean;
  current: boolean;
};
import {
  wizardInitial, wizardReduce, type WizardStep,
  restoreInitial, restoreReduce, type RestoreStep,
  probeStatus, type SecurityStatus, autoPassphrase,
} from "./state.js";

export interface SecurityAdapter {
  bootstrap(opts: { client: MatrixClient; userId: string; password: string; passphrase: string }): Promise<string>;
  restorePassphrase(client: MatrixClient, passphrase: string, onProgress: (p: { total?: number; imported?: number }) => void): Promise<number>;
  restoreRecoveryKey(client: MatrixClient, key: string, onProgress: (p: { total?: number; imported?: number }) => void): Promise<number>;
  status(client: MatrixClient): Promise<SecurityStatus>;
  runBackup(client: MatrixClient): Promise<void>;
  sessions(client: MatrixClient): Promise<SessionRow[]>;
  beginDeviceVerification(client: MatrixClient, targetDeviceId: string): Promise<VerifyHandle>;
  revoke(client: MatrixClient, deviceId: string, password: string): Promise<void>;
  /** W8: POST /logout/all — kill every other session, keep this one. No UIAA. */
  logoutAll(client: MatrixClient): Promise<void>;
  onIncomingRequest(client: MatrixClient, cb: (h: VerifyHandle, request: unknown) => void): () => void;
}

export function SecurityBanner(props: { status: SecurityStatus | null; encrypted: boolean; onClick: () => void }): ReactNode {
  if (!props.encrypted) return null;
  const s = props.status;
  let cls = "off";
  let text = "Encryption";
  if (s?.cryptoAvailable && s.ready === true) {
    cls = "on";
    text = "Secured";
  } else if (s?.cryptoAvailable && s.ready === false) {
    cls = "warn";
    text = "Set up encryption";
  } else if (s && !s.cryptoAvailable) {
    cls = "warn";
    text = "Crypto unavailable";
  }
  return (
    <button
      className={`e2ee-badge ${cls}`}
      onClick={props.onClick}
      data-testid="security-banner"
      title="Room encryption status — open security center"
    >
      🔒 {text}
    </button>
  );
}

export interface SheetProps {
  client: MatrixClient;
  adapter: SecurityAdapter;
  onClose: () => void;
}

export function SecuritySheet(props: SheetProps): ReactNode {
  const { client, adapter, onClose } = props;
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [flow, setFlow] = useState<"none" | "setup" | "recover" | "sessions">("none");
  const [verify, setVerify] = useState<VerifyHandle | null>(null);
  const [incoming, setIncoming] = useState(false);

  const refresh = useCallback(() => {
    adapter.status(client).then(setStatus).catch(() => setStatus(null));
  }, [adapter, client]);
  useEffect(() => refresh(), [refresh]);

  // W12 item 2: the sheet is fixed-position chrome without useModalA11y;
  // Escape must close it like every other openable surface
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // while the sheet is open, an incoming verification from another session
  // takes over the panel (MVP scope; a global nudge centre is P2 per PRD)
  useEffect(() => {
    if (typeof adapter.onIncomingRequest !== "function") return;
    return adapter.onIncomingRequest(client, (h) => {
      setIncoming(true);
      setVerify(h);
    });
  }, [adapter, client]);

  return (
    <div className="sheet-backdrop" data-testid="security-sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet security-center hc" data-position="center" data-contrast="wcag" role="dialog" aria-modal="true" aria-label="Security and recovery">
        <header>
          <span>Security &amp; encryption</span>
          <button aria-label="Close" onClick={onClose} data-testid="sheet-close">✕</button>
        </header>

        {flow === "none" && (
          <>
            <div className="status-line" data-testid="security-status">
              {status == null && "checking…"}
              {status && !status.cryptoAvailable && "Crypto is not available in this build — end-to-end decryption is offline."}
              {status?.cryptoAvailable && status.ready === true && <>✓ Cross-signing, secret storage and key backup are all <b>on</b>.</>}
              {status?.cryptoAvailable && status.ready === null && "Security status is still loading…"}
              {status?.cryptoAvailable && status.ready === false && (
                <>Your sessions can encrypt, but backup/verification is <b>not finished</b>. If you lose this device, encrypted history is unrecoverable.</>
              )}
              {status?.backupEnabled && (
                <span className="count"> · backup: {status.backupCount ?? "?"} keys</span>
              )}
            </div>

            {status?.cryptoAvailable && status.ready === false && (
              <button className="primary" onClick={() => setFlow("setup")} data-testid="start-setup">
                Set up encryption
              </button>
            )}
            <button onClick={() => setFlow("recover")} data-testid="start-recover">Recover encrypted history</button>
            <button
              onClick={() => void adapter.runBackup(client).then(refresh)}
              disabled={!status?.backupEnabled}
              data-testid="backup-now"
            >
              Back up now
            </button>
            <button onClick={() => setFlow("sessions")} data-testid="start-sessions">Sessions &amp; devices</button>
          </>
        )}

        {flow === "setup" && <SetupWizard client={client} adapter={adapter} onDone={() => { setFlow("none"); refresh(); }} />}
        {flow === "recover" && <RecoverFlow client={client} adapter={adapter} onDone={() => setFlow("none")} />}
        {flow === "sessions" && (
          verify ? (
            <SasPanel handle={verify} incoming={incoming} onDone={() => { setVerify(null); setIncoming(false); }} />
          ) : (
            <SessionsSection
              client={client}
              adapter={adapter}
              myUserId={client.getUserId() ?? ""}
              onVerifyHandle={(h) => setVerify(h)}
            />
          )
        )}
        {verify && flow !== "sessions" && (
          <div className="incoming-verify" data-testid="incoming-verify">
            <SasPanel handle={verify} incoming onDone={() => { setVerify(null); setIncoming(false); }} />
          </div>
        )}
      </div>
    </div>
  );
}

function SetupWizard(props: { client: MatrixClient; adapter: SecurityAdapter; onDone: () => void }): ReactNode {
  const [wiz, setWiz] = useState<WizardStep>(wizardInitial);
  const [saved, setSaved] = useState(false);

  function dispatch(ev: Parameters<typeof wizardReduce>[1]): void {
    setWiz((prev) => wizardReduce(prev, ev));
  }

  // side effect belongs to the STATE: any time we sit on "working" (first
  // entry or retry), run bootstrap exactly once for those params
  const lastRun = useRef<string | null>(null);
  useEffect(() => {
    if (wiz.step !== "working") return;
    const id = `${wiz.password}::${wiz.passphrase}`;
    if (lastRun.current === id) return;
    lastRun.current = id;
    let dead = false;
    props.adapter
      .bootstrap({
        client: props.client,
        userId: props.client.getUserId() ?? "",
        password: wiz.password,
        passphrase: wiz.passphrase,
      })
      .then((recoveryKey) => !dead && dispatch({ t: "success", recoveryKey }))
      .catch((e) => {
        lastRun.current = null; // allow retry to re-run with same params
        if (!dead) dispatch({ t: "fail", message: (e as Error).message });
      });
    return () => {
      dead = true;
    };
  }, [wiz, props.adapter, props.client]);

  switch (wiz.step) {
    case "intro":
      return (
        <div className="wizard" data-testid="wizard">
          <p>Linnet will create your signing identity, a Secure Secret Storage + a server key backup, and show you a <b>recovery key</b> once. Keep it offline.</p>
          <button className="primary" onClick={() => dispatch({ t: "begin" })} data-testid="wizard-begin">Start</button>
        </div>
      );
    case "credentials":
      return (
        <form className="wizard" data-testid="wizard" onSubmit={(e) => e.preventDefault()}>
          <p>Confirm your account password (authorises the key operations):</p>
          <input
            type="password"
            aria-label="Account password"
            value={wiz.password}
            onChange={(e) => dispatch({ t: "password", value: e.target.value })}
            data-testid="wizard-password"
          />
          <button className="primary" disabled={!wiz.password} onClick={() => dispatch({ t: "credsNext" })} data-testid="wizard-creds-next">Next</button>
        </form>
      );
    case "keymode":
      return <KeyModeStep setWiz={dispatch} />;
    case "working":
      return (
        <div className="wizard" data-testid="wizard">
          <p className="spin" data-testid="wizard-working">Setting up keys…</p>
        </div>
      );
    case "showKey":
      return (
        <div className="wizard" data-testid="wizard">
          <p>Save this recovery key somewhere safe. It is shown <b>once</b>:</p>
          <code className="recovery-key" data-testid="recovery-key">{wiz.recoveryKey}</code>
          <label className="ack">
            <input type="checkbox" aria-label="I have saved my recovery key" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved my recovery key
          </label>
          <button className="primary" disabled={!saved} onClick={() => { dispatch({ t: "ack" }); props.onDone(); }} data-testid="wizard-ack-done">
            Done
          </button>
        </div>
      );
    case "done":
      return <div className="wizard" data-testid="wizard">✓ Encryption is set up.</div>;
    case "error":
      return (
        <div className="wizard" data-testid="wizard">
          <p className="err" data-testid="wizard-error">{wiz.message}</p>
          <button onClick={() => dispatch({ t: "retry" })} data-testid="wizard-retry">Retry</button>
        </div>
      );
  }
}

function KeyModeStep(props: {
  setWiz: (e: { t: "choose"; mode: "passphrase" | "auto"; passphrase: string }) => void;
}): ReactNode {
  const [mode, setMode] = useState<"passphrase" | "auto">("auto");
  const [pass, setPass] = useState("");
  const ready = mode === "auto" || pass.length >= 8;
  return (
    <div className="wizard" data-testid="wizard">
      <fieldset>
        <legend>Recovery secret</legend>
        <label>
          <input type="radio" name="km" aria-label="Generate a recovery key for me" checked={mode === "auto"} onChange={() => setMode("auto")} />
          Generate a recovery key for me
        </label>
        <label>
          <input type="radio" name="km" aria-label="Choose a security passphrase" checked={mode === "passphrase"} onChange={() => setMode("passphrase")} />
          Choose a security passphrase
        </label>
      </fieldset>
      {mode === "passphrase" && (
        <input
          type="password"
          aria-label="Security passphrase"
          placeholder="min 8 characters"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          data-testid="wizard-passphrase"
        />
      )}
      <button
        className="primary"
        disabled={!ready}
        onClick={() => {
          const passphrase = mode === "auto" ? autoPassphrase() : pass;
          props.setWiz({ t: "choose", mode, passphrase });
        }}
        data-testid="wizard-go"
      >
        Set up
      </button>
    </div>
  );
}

function RecoverFlow(props: { client: MatrixClient; adapter: SecurityAdapter; onDone: () => void }): ReactNode {
  const [stRaw, setStRaw] = useState<RestoreStep>(restoreInitial);
  const lastRestore = useRef<string | null>(null);
  function dispatchSt(ev: Parameters<typeof restoreReduce>[1]): void {
    setStRaw((prev) => restoreReduce(prev, ev));
  }
  const st = stRaw ?? restoreInitial;
  const { client, adapter } = props;

  async function run(route: "passphrase" | "key", value: string): Promise<void> {
    const onProgress = (p: { total?: number; imported?: number }) => dispatchSt({ t: "progress", ...p });
    const id = `${route}::${value}`;
    if (lastRestore.current === id) return;
    lastRestore.current = id;
    try {
      const n = route === "passphrase"
        ? await adapter.restorePassphrase(client, value, onProgress)
        : await adapter.restoreRecoveryKey(client, value, onProgress);
      dispatchSt({ t: "done", imported: n });
    } catch (e) {
      lastRestore.current = null;
      dispatchSt({ t: "fail", message: (e as Error).message });
    }
  }

  // state-driven side effect: sitting on "working" (submit OR retry) runs it
  useEffect(() => {
    if (st.step === "working") void run(st.route, st.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.step]);

  switch (st.step) {
    case "route":
      return (
        <div className="recover hc" data-contrast="wcag" data-testid="recover">
          <p>How do you want to unlock your encrypted history?</p>
          <button onClick={() => dispatchSt({ t: "pick", route: "passphrase" })} data-testid="recover-pass">Security passphrase</button>
          <button onClick={() => dispatchSt({ t: "pick", route: "key" })} data-testid="recover-key">Recovery key</button>
        </div>
      );
    case "input":
      return (
        <form className="recover hc" data-contrast="wcag" data-testid="recover" onSubmit={(e) => e.preventDefault()}>
          <input
            aria-label={st.route === "key" ? "Recovery key" : "Security passphrase"}
            type={st.route === "key" ? "text" : "password"}
            value={st.value}
            onChange={(e) => dispatchSt({ t: "value", value: e.target.value })}
            data-testid="recover-input"
          />
          <button
            className="primary"
            disabled={!st.value}
            onClick={() => {
              dispatchSt({ t: "submit" });
            }}
            data-testid="recover-go"
          >
            Recover
          </button>
        </form>
      );
    case "working":
    case "progress":
      return (
        <div className="recover hc" data-contrast="wcag" data-testid="recover">
          <p data-testid="recover-progress">
            {st.step === "progress" && st.total ? `Importing ${st.imported ?? 0}/${st.total} keys…` : "Unlocking…"}
          </p>
        </div>
      );
    case "done":
      return (
        <div className="recover hc" data-contrast="wcag" data-testid="recover">
          <p data-testid="recover-done">✓ Imported {st.imported} decryption keys.</p>
          <button onClick={props.onDone} data-testid="recover-close">Close</button>
        </div>
      );
    case "error":
      return (
        <div className="recover hc" data-contrast="wcag" data-testid="recover">
          <p className="err" data-testid="recover-error">{st.message}</p>
          <button onClick={() => dispatchSt({ t: "retry" })} data-testid="recover-retry">Try again</button>
        </div>
      );
  }
}

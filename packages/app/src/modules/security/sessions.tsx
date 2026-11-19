/**
 * linnet.security sessions & SAS verification UI. All js-sdk plumbing lives
 * behind the adapter handles (SecurityAdapter additions) so the components
 * unit-test with pure mocks; the live proof runs on HS-A.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { SecurityAdapter } from "./Security.js";

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

export function SasPanel(props: { handle: VerifyHandle; onDone: () => void; incoming?: boolean }): ReactNode {
  const { handle } = props;
  const [entries, setEntries] = useState<SasEntry[] | null>(null);
  const [status, setStatus] = useState<"waiting" | "show" | "done" | "cancelled">("waiting");

  useEffect(() => {
    let dead = false;
    handle
      .entries()
      .then((e) => {
        if (!dead) {
          setEntries(e);
          setStatus("show");
        }
      })
      .catch(() => !dead && setStatus("cancelled"));
    void handle.finished().then((r) => !dead && setStatus(r === "done" ? "done" : "cancelled"));
    return () => {
      dead = true;
    };
  }, [handle]);

  if (status === "waiting") {
    return (
      <div className="sas-panel" data-testid="sas-panel">
        <p data-testid="sas-waiting">{props.incoming ? "Another session wants to verify — accept to continue." : "Waiting for the other session to accept…"}</p>
      </div>
    );
  }
  if (status === "done") {
    return (
      <div className="sas-panel" data-testid="sas-panel">
        <p data-testid="sas-done">✓ Sessions verified. Cross-signing now trusts it.</p>
        <button onClick={props.onDone} data-testid="sas-close">Close</button>
      </div>
    );
  }
  if (status === "cancelled") {
    return (
      <div className="sas-panel" data-testid="sas-panel">
        <p data-testid="sas-cancelled">Verification cancelled.</p>
        <button onClick={props.onDone} data-testid="sas-close">Close</button>
      </div>
    );
  }
  return (
    <div className="sas-panel" data-testid="sas-panel">
      <p>Compare these with the other session — do they match?</p>
      <ul className="sas-emojis" data-testid="sas-entries">
        {(entries ?? []).map((e, i) => (
          <li key={i}>
            <span className="emoji">{e.emoji?.[0] ?? "#"}</span> <span className="desc">{e.description}</span>
          </li>
        ))}
      </ul>
      <div className="sas-actions">
        <button className="primary" onClick={() => void handle.confirm().catch(() => undefined)} data-testid="sas-match">
          They match
        </button>
        <button onClick={() => void handle.cancel().catch(() => undefined)} data-testid="sas-nomatch">
          They don’t match
        </button>
      </div>
    </div>
  );
}

export function SessionsSection(props: {
  client: MatrixClient;
  adapter: SecurityAdapter;
  myUserId: string;
  onVerifyHandle: (h: VerifyHandle) => void;
}): ReactNode {
  const { client, adapter } = props;
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ deviceId: string; password: string } | null>(null);

  const load = () => {
    adapter.sessions(client).then(setRows).catch((e: unknown) => setErr(String((e as Error).message)));
  };
  useEffect(() => load(), [adapter, client]);

  async function revoke(deviceId: string, password: string): Promise<void> {
    try {
      setErr(null);
      await adapter.revoke(client, deviceId, password);
      setRevoking(null);
      load();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  }

  if (rows == null && !err) return <p className="note" data-testid="sessions-loading">Loading sessions…</p>;
  return (
    <div className="sessions" data-testid="sessions">
      {err && <p className="err" data-testid="sessions-error">{err}</p>}
      <ul className="session-list">
        {(rows ?? []).map((r) => (
          <li key={r.deviceId} data-testid={`session-${r.deviceId}`}>
            <div className="session-main">
              <b>{r.name || r.deviceId}</b>
              {r.current && <span className="tag">this session</span>}
              <span className={r.verified ? "tag ok" : "tag warn"} data-testid={`verified-${r.deviceId}`}>
                {r.verified ? "✓ verified" : "unverified"}
              </span>
            </div>
            <div className="session-meta">{r.lastSeen ?? "never seen"}{r.ip ? ` · ${r.ip}` : ""}</div>
            <div className="session-actions">
              {!r.verified && !r.current && (
                <button
                  onClick={() => void adapter.beginDeviceVerification(client, r.deviceId).then(props.onVerifyHandle).catch((e: unknown) => setErr(String((e as Error).message)))}
                  data-testid={`verify-${r.deviceId}`}
                >
                  Verify
                </button>
              )}
              {!r.current &&
                (() => {
                  const rev = revoking && revoking.deviceId === r.deviceId ? revoking : null;
                  return rev ? (
                    <span className="revoke-form">
                      <input
                        type="password"
                        aria-label="Password to confirm"
                        value={rev.password}
                        onChange={(e) => setRevoking({ deviceId: r.deviceId, password: e.target.value })}
                        data-testid={`revoke-pw-${r.deviceId}`}
                      />
                      <button onClick={() => void revoke(r.deviceId, rev.password)} data-testid={`revoke-go-${r.deviceId}`}>Confirm</button>
                      <button onClick={() => setRevoking(null)}>✕</button>
                    </span>
                  ) : (
                    <button className="danger" onClick={() => setRevoking({ deviceId: r.deviceId, password: "" })} data-testid={`revoke-${r.deviceId}`}>
                      Revoke
                    </button>
                  );
                })()}
            </div>
          </li>
        ))}
      </ul>
      <p className="note">A fresh web session can only be verified FROM an existing trusted session (this screen).</p>
    </div>
  );
}

/**
 * W19 3a — account-menu row for email notification digests. The truth is
 * server-side (pusher registry + 3PIDs), fetched once on mount:
 *  - no email 3PID on the account  -> explain, offer nothing
 *  - foreign email pusher          -> informational (don't fight Element)
 *  - ours on/off                   -> one checkbox
 * Copy discipline (design doc §4): we NEVER promise mail actually arrives —
 * that needs the homeserver admin's SMTP. We also never touch push RULES:
 * they are account-wide and shared with other clients.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import {
  EmailPusherManager,
  extractPrimaryEmail,
  isThreepidNotFound,
  type EmailPusherStatus,
} from "@linnet/core";

type Phase =
  | { s: "loading" }
  | { s: "ready"; email: string | null; verified: boolean; status: EmailPusherStatus }
  | { s: "error"; message: string };

export interface EmailPusherRowProps {
  client: MatrixClient;
}

export function EmailPusherRow({ client }: EmailPusherRowProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ s: "loading" });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const mgr = new EmailPusherManager(client);
    try {
      const tp = await client.getThreePids();
      const primary = extractPrimaryEmail(tp.threepids ?? []);
      const status = await mgr.status();
      setPhase({ s: "ready", email: primary?.address ?? null, verified: primary?.verified ?? false, status });
    } catch (err) {
      setPhase({ s: "error", message: String((err as Error)?.message ?? err) });
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (phase.s === "loading") {
    return (
      <div className="appearance-row" role="group" aria-label="Email">
        <span className="lbl">Email</span>
        <span className="update-status" data-testid="email-status">
          checking…
        </span>
      </div>
    );
  }
  if (phase.s === "error") {
    return (
      <div className="appearance-row" role="group" aria-label="Email">
        <span className="lbl">Email</span>
        <span className="update-status" data-testid="email-status">
          {phase.message}
        </span>
      </div>
    );
  }

  const mgr = new EmailPusherManager(client);
  const deviceId = client.getDeviceId() ?? "";

  const toggle = async (on: boolean): Promise<void> => {
    if (phase.s !== "ready" || !phase.email) return;
    setBusy(true);
    try {
      if (on) await mgr.enable(phase.email, deviceId, "Linnet");
      else await mgr.disable(deviceId);
    } catch (err) {
      setPhase({
        s: "error",
        message: isThreepidNotFound(err)
          ? "the server only emails your account's own email address"
          : String((err as Error)?.message ?? err),
      });
      setBusy(false);
      return;
    }
    setBusy(false);
    await reload();
  };

  const on = phase.status.kind === "on";
  let statusText = "";
  if (phase.status.kind === "foreign") statusText = `digests already on (${phase.status.email})`;
  else if (!phase.email) statusText = "no email on your account — add one first";
  else statusText = on ? `digest to ${phase.email}` : "off";

  return (
    <div className="appearance-row" role="group" aria-label="Email">
      <span className="lbl">Email</span>
      <span className="update-status" data-testid="email-status">
        {busy ? "saving…" : statusText}
      </span>
      <label className="update-enable">
        <input
          type="checkbox"
          data-testid="email-digest-toggle"
          checked={on}
          disabled={busy || !phase.email || phase.status.kind === "foreign"}
          onChange={(e) => void toggle(e.target.checked)}
        />
        digest
      </label>
    </div>
  );
}

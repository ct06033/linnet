/**
 * W19 3a — email notification pushers (the zero-infrastructure half of the
 * push design doc, decisions D1/D3 as amended by source verification):
 *
 * Synapse delivers email pushers as THROTTLED UNREAD DIGESTS per room
 * (10 min -> 24 h; synapse/push/emailpusher.py), not per message. The
 * pushkey IS the email address and Synapse refuses one that is not already
 * a verified 3PID of the registering account (pusherpool.py:
 * THREEPID_NOT_FOUND otherwise). Delivery additionally requires the HS
 * admin's SMTP config, which is NOT probe-able from a client — so the UI
 * copy must promise "your homeserver sends them if enabled", never more.
 * Push RULES are account-wide and shared with other clients; we therefore
 * never mutate rules here (that would silently change Element's badges).
 */
import type { MatrixClient } from "matrix-js-sdk";

/** app_id namespace for Linnet email digests. A suffix distinguishes
 *  multiple emails/devices without fighting over one record. */
export function emailAppId(deviceId: string): string {
  return `chat.linnet.email.${deviceId || "default"}`;
}

export interface AccountEmail {
  address: string;
  verified: boolean;
}

/** Pick the account's primary email from /account/3pid data. Verified
 *  entries win; unverified are still returned (Synapse accepts them — the
 *  mail itself only lands if the address is reachable). */
export function extractPrimaryEmail(
  threepids: Array<{ medium: string; address: string; verified?: boolean }>,
): AccountEmail | null {
  const emails = threepids.filter((t) => t.medium === "email");
  if (emails.length === 0) return null;
  const verified = emails.find((e) => e.verified);
  const pick = verified ?? emails[0]!;
  return { address: pick.address, verified: Boolean(pick.verified) };
}

/** The exact pushers/set body Synapse expects for a digest registration.
 *  data stays empty: kind=email ignores transport data server-side. */
export function emailPusherRequest(email: string, deviceId: string, displayName: string) {
  return {
    kind: "email" as const,
    app_id: emailAppId(deviceId),
    app_display_name: "Linnet email digests",
    device_display_name: displayName,
    pushkey: email,
    lang: "en",
    data: {},
  };
}

/** M_THREEPID_NOT_FOUND => the address isn't 3PID-linked on this account. */
export function isThreepidNotFound(err: unknown): boolean {
  const e = err as { errcode?: string; http_status?: number; data?: { errcode?: string } };
  const code = e?.errcode ?? e?.data?.errcode ?? "";
  return code === "M_THREEPID_NOT_FOUND" || (e?.http_status === 400 && /email not found/i.test(String((e as Error)?.message)));
}

export type EmailPusherStatus =
  | { kind: "off" }
  | { kind: "on"; email: string }
  | { kind: "foreign"; email: string }; // a pusher we didn't name (e.g. Element's)

export class EmailPusherManager {
  private readonly client: MatrixClient;

  constructor(client: MatrixClient) {
    this.client = client;
  }

  async status(): Promise<EmailPusherStatus> {
    const res = await this.client.getPushers();
    const mine = (res.pushers ?? []).filter(
      (p) => p.kind === "email" && typeof p.app_id === "string" && p.app_id.startsWith("chat.linnet.email."),
    );
    if (mine.length > 0) return { kind: "on", email: String(mine[0]!.pushkey) };
    const other = (res.pushers ?? []).find((p) => p.kind === "email");
    if (other) return { kind: "foreign", email: String(other.pushkey) };
    return { kind: "off" };
  }

  /** Register the digest pusher. Throws MatrixError (inspect via
   *  isThreepidNotFound) when Synapse rejects the address.
   *
   *  Side effect that matters: Synapse only materialises a user's default
   *  push-ruleset on the FIRST GET /pushrules (verified on HS-A 1.165: an
   *  account that never fetched rules has zero rows, so the push evaluator
   *  produces nothing and no email would ever be sent). Linnet's own
   *  notification engine does not use server rules, so we pull them here —
   *  exactly like Element does at client start. */
  async enable(email: string, deviceId: string, displayName: string): Promise<void> {
    try {
      await this.client.getPushRules();
    } catch {
      /* rule bootstrap is best-effort; the registration below is the truth */
    }
    await this.client.setPusher(emailPusherRequest(email, deviceId, displayName) as never);
  }

  async disable(deviceId: string): Promise<void> {
    const res = await this.client.getPushers();
    const mine = (res.pushers ?? []).filter((p) => p.app_id === emailAppId(deviceId));
    for (const p of mine) {
      await this.client.removePusher(p.pushkey, String(p.app_id));
    }
  }
}

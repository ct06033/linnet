/**
 * Production SecurityAdapter — thin delegation to the HS-A-proven core e2ee
 * functions + js-sdk verification primitives. The UI never touches js-sdk
 * crypto directly; everything funnels through here.
 */
import type { MatrixClient } from "matrix-js-sdk";
import {
  bootstrapSecurity,
  describeSecurityAccount,
  resetSecurityAccess,
  restoreBackupWithPassphrase,
  restoreBackupWithRecoveryKey,
  rotateRecoveryMethod,
  unlockWithSecret,
} from "@linnet/core";
import type { SecurityAdapter, SasEntry, SessionRow, VerifyHandle } from "./Security.js";
import { probeStatus } from "./state.js";

function tokenOf(client: MatrixClient): string {
  return (client as unknown as { getAccessToken?: () => string | null }).getAccessToken?.() ?? "";
}

// ---------------------------------------------------------------- verification

interface SasCallbacks {
  sas: SasEntry[];
  confirm(): Promise<void>;
  cancel(): Promise<void>;
}
// Runtime shape (matrix-js-sdk 45 + wasm 18.9.2), live-proven on HS-A
// (W5a-3): the Verifier has NO waitForDone, the request's is the phase enum
// (Done=5, Cancelled=6), and the RECEIVER must call verify() to flush its
// SAS start — rust never auto-sends it (emojis stay hidden forever otherwise).
interface VerifierLike {
  verify?(): Promise<unknown>;
  getShowSasCallbacks?(): SasCallbacks | null;
  callbacks?: SasCallbacks | null;
  on(ev: string, cb: (...args: never[]) => void): void;
}
interface RequestLike {
  verifier?: VerifierLike;
  phase?: number;
  accept?(): Promise<void>;
  cancel?(p?: { reason?: string }): Promise<void>;
  on(ev: string, cb: (...a: never[]) => void): void;
  off(ev: string, cb: (...a: never[]) => void): void;
}

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getVerifier(request: RequestLike, timeoutMs = 60000): Promise<VerifierLike> {
  const t0 = Date.now();
  for (;;) {
    // rq.verifier is only exposed once the request reaches Started phase
    if (request.verifier) return request.verifier;
    if (request.phase === 6) throw new Error("verification cancelled");
    if (Date.now() - t0 > timeoutMs) throw new Error("verification timed out waiting for the other session");
    await nap(150);
  }
}

/** Wrap a js-sdk VerificationRequest into the UI's VerifyHandle contract.
 *  Sequence per the W5a-3 live proof: verifier appears at Started -> drive
 *  verify() (sends OUR sas start; no-op on the initiator) -> poll
 *  getShowSasCallbacks() (show_sas does NOT replay as an event; the accessor
 *  does) -> confirm/cancel -> poll request phase for Done(5)/Cancelled(6). */
export function handleFor(rawRequest: unknown): VerifyHandle {
  const request = rawRequest as RequestLike;
  let sasCb: SasCallbacks | null = null;
  const showP = getVerifier(request)
    .then(async (v) => {
      void Promise.resolve(v.verify?.()).catch(() => {
        /* flow ends in cancel/timeout — phase polling below resolves the UI */
      });
      const t0 = Date.now();
      for (;;) {
        const cb = v.getShowSasCallbacks?.() ?? v.callbacks ?? null;
        if (cb) {
          sasCb = cb;
          return cb;
        }
        if (Date.now() - t0 > 45000) throw new Error("timed out waiting for the other session to start SAS");
        await nap(100);
      }
    })
    .catch(() => null);
  const finishedP = (async (): Promise<"done" | "cancelled"> => {
    const t0 = Date.now();
    for (;;) {
      if (request.phase === 5) return "done";
      if (request.phase === 6) return "cancelled";
      if (Date.now() - t0 > 120000) return "cancelled";
      await nap(250);
    }
  })();
  return {
    entries: async () => (await showP)?.sas ?? [],
    confirm: async () => {
      await (sasCb ?? (await showP))?.confirm();
    },
    cancel: async () => {
      try {
        await (sasCb ?? (await showP))?.cancel();
      } catch {
        await request.cancel?.({ reason: "cancelled in linnet" });
      }
    },
    finished: () => finishedP,
  };
}

// ---------------------------------------------------------------- adapter

export const prodAdapter: SecurityAdapter = {
  async bootstrap(opts) {
    const r = await bootstrapSecurity(opts);
    return r.recoveryKey;
  },
  restorePassphrase: (client, passphrase, onProgress) =>
    restoreBackupWithPassphrase(client, passphrase, onProgress),
  restoreRecoveryKey: (client, key, onProgress) =>
    restoreBackupWithRecoveryKey(client, key, onProgress),
  // W14: SSSS account + locked session -> core unlockWithSecret (proves the
  // secret, parks the key for the client callback, imports cross-signing
  // from 4S, restores the key backup). Returns the imported count.
  async unlock({ client, secret, onProgress }) {
    const r = await unlockWithSecret({ client, secret, onProgress });
    return r.imported;
  },
  // W23-B: DESTRUCTIVE locked-out reset -> core resetSecurityAccess (rotate
  // 4S to a new passphrase-derived key, NEW cross-signing identity behind
  // UIA-with-identifier, replace the server backup). The UI already forced
  // the honest impact screen; wrong-password/UIA rejections propagate
  // verbatim from core — no wrapping here either.
  async resetSecurity(opts) {
    return await resetSecurityAccess(opts);
  },
  // W24 ROUTE E: NON-destructive recovery-method rotation -> core
  // rotateRecoveryMethod (prove old, set new passphrase, re-wrap 4S, import
  // cross-signing from the NEW 4S, restore history). Identity preserved,
  // no UIA, no account password. Raw decryption errors mapped in the UI via
  // mapSecretStorageError; everything else propagates verbatim.
  async rotateRecovery({ client, userId, secret, passphrase, onProgress }) {
    return await rotateRecoveryMethod({ client, userId, secret, newPassphrase: passphrase, onProgress });
  },
  // W23-D: account readout (server-first reads, no secret values ever).
  describeAccount: (client) => describeSecurityAccount(client),
  status: async (client) =>
    probeStatus(client as unknown as Parameters<typeof probeStatus>[0], tokenOf(client)),
  async runBackup(client) {
    const crypto = client.getCrypto?.();
    await (crypto as unknown as { checkKeyBackupAndEnable?: () => Promise<unknown> } | undefined)?.checkKeyBackupAndEnable?.();
  },

  async sessions(client) {
    const me = client.getUserId() ?? "";
    const crypto = client.getCrypto?.() as unknown as
      | { getUserDeviceInfo(ids: string[]): Promise<Map<string, Map<string, { verified?: unknown }>>> }
      | null
      | undefined;
    const list = (client as unknown as { getDevices(): Promise<{ devices: Array<{ device_id: string; display_name?: string; last_seen_ip?: string; last_seen_ts?: number }> }> }).getDevices.bind(client);
    const [{ devices }, devMap] = await Promise.all([list(), crypto ? crypto.getUserDeviceInfo([me]) : Promise.resolve(null)]);
    const own = devMap?.get?.(me);
    const myDeviceId = (client as unknown as { deviceId?: string }).deviceId ?? "";
    return devices.map((d) => ({
      deviceId: d.device_id,
      name: d.display_name ?? "",
      lastSeen: d.last_seen_ts ? new Date(d.last_seen_ts).toLocaleDateString() : undefined,
      ip: d.last_seen_ip || undefined,
      verified: Boolean(own?.get(d.device_id)?.verified),
      current: d.device_id === myDeviceId,
    }));
  },

  async beginDeviceVerification(client, targetDeviceId) {
    const me = client.getUserId() ?? "";
    const rc = client.getCrypto?.() as unknown as
      | { requestDeviceVerification?(u: string, d: string): Promise<unknown> }
      | undefined;
    // js-sdk 45's PUBLIC requestVerificationDM is broken for self-verification
    // (wasm 18.9.2 OwnUserIdentity lacks verificationRequestContent); the
    // runtime-only RustCrypto requestDeviceVerification(userId, deviceId)
    // returns the standard js-sdk VerificationRequest wrapper and flushes
    // outgoing requests itself — live-proven on HS-A (W5a-3).
    if (!rc?.requestDeviceVerification) throw new Error("this build cannot start verification (crypto unavailable)");
    const request = await rc.requestDeviceVerification(me, targetDeviceId);
    // HS-A-probed protocol: the request waits at Ready until the other
    // session accepts; the INITIATOR then calls startVerification exactly
    // once. Repeat calls violate rust's state machine and CANCEL the flow.
    const rq = request as {
      startVerification?(m: string): Promise<unknown>;
      verifier?: unknown;
      phase?: number;
    };
    void (async () => {
      for (let i = 0; i < 240; i++) {
        if (rq.verifier) return;
        if (rq.phase === 3) {
          try {
            await rq.startVerification?.("m.sas.v1");
          } catch {
            /* the other side may have started it already */
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    return handleFor(request);
  },

  async revoke(client, deviceId, password) {
    const me = client.getUserId() ?? "";
    await (client as unknown as {
      deleteDevice(id: string, auth?: unknown): Promise<unknown>;
      refreshDevices?(): Promise<void>;
    }).deleteDevice(deviceId, {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: me },
      password,
    });
    await (client as unknown as { refreshDevices?(): Promise<void> }).refreshDevices?.();
  },

  async logoutAll(client) {
    // W8: /logout/all takes no UIAA (unlike delete_devices) — one POST, every
    // other session of this device dies. Token via public getter when present.
    const tok = (client as unknown as { getAccessToken?(): string | null }).getAccessToken?.()
      ?? (client as unknown as { accessToken?: string }).accessToken;
    if (!tok) throw new Error("logout all: no access token");
    const res = await fetch(`${client.getHomeserverUrl()}/_matrix/client/v3/logout/all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`logout all failed: HTTP ${res.status}`);
    await (client as unknown as { refreshDevices?(): Promise<void> }).refreshDevices?.();
  },

  onIncomingRequest(client, cb) {
    // NOT a root export in matrix-js-sdk 45 (root barrel omits CryptoEvent —
    // found by runtime TypeError, not by tsc); spec string is stable.
    const handler = (request: { accept?(): Promise<void> }): void => {
      void Promise.resolve(request.accept?.()).then(() => cb(handleFor(request), request));
    };
    (client as unknown as { on(e: string, h: (...a: never[]) => void): void }).on(
      "crypto.verificationRequestReceived",
      handler as never,
    );
    return () => {
      (client as unknown as { off(e: string, h: (...a: never[]) => void): void }).off(
        "crypto.verificationRequestReceived",
        handler as never,
      );
    };
  },
};

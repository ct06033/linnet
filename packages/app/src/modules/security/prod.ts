/**
 * Production SecurityAdapter — thin delegation to the HS-A-proven core e2ee
 * functions + js-sdk verification primitives. The UI never touches js-sdk
 * crypto directly; everything funnels through here.
 */
import { EventType } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import {
  bootstrapSecurity,
  restoreBackupWithPassphrase,
  restoreBackupWithRecoveryKey,
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
interface VerifierLike {
  on(ev: string, cb: (...args: never[]) => void): void;
  on(ev: "show_sas", cb: (cb: SasCallbacks) => void): void;
  waitForDone?(): Promise<boolean>;
}
interface RequestLike {
  verifier?: unknown;
  accept?(): Promise<void>;
  cancel?(p?: { reason?: string }): Promise<void>;
  on(ev: string, cb: (...a: never[]) => void): void;
  off(ev: string, cb: (...a: never[]) => void): void;
}

function getVerifier(request: unknown, timeoutMs = 60000): Promise<VerifierLike> {
  const req = request as RequestLike;
  if (req.verifier) return Promise.resolve(req.verifier as VerifierLike);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.off("change", onChange);
      reject(new Error("verification timed out waiting for the other session"));
    }, timeoutMs);
    function onChange(): void {
      if (req.verifier) {
        clearTimeout(timer);
        req.off("change", onChange);
        resolve(req.verifier as VerifierLike);
      }
    }
    req.on("change", onChange as never);
  });
}

/** Wrap a js-sdk VerificationRequest into the UI's VerifyHandle contract. */
export function handleFor(request: unknown): VerifyHandle {
  const verifierP = getVerifier(request);
  let sasCb: SasCallbacks | null = null;
  const showP = verifierP.then(
    (v) =>
      new Promise<SasCallbacks>((resolve) => {
        v.on("show_sas", ((cb: SasCallbacks) => {
          sasCb = cb;
          resolve(cb);
        }) as never);
      }),
  );
  const finishedP = new Promise<"done" | "cancelled">((resolve) => {
    void verifierP
      .then((v) => {
        v.on("cancel", (() => resolve("cancelled")) as never);
        if (typeof v.waitForDone === "function") {
          void v.waitForDone().then((ok) => resolve(ok === false ? "cancelled" : "done"));
        } else {
          void (request as { waitForDone?: () => Promise<void> }).waitForDone?.().then(() => resolve("done"));
        }
      })
      .catch(() => resolve("cancelled"));
  });
  return {
    entries: async () => (await showP).sas,
    confirm: async () => {
      await (sasCb ?? (await showP)).confirm();
    },
    cancel: async () => {
      try {
        await (sasCb ?? (await showP)).cancel();
      } catch {
        await (request as RequestLike).cancel?.({ reason: "cancelled in linnet" });
      }
    },
    finished: () => finishedP,
  };
}

// ---------------------------------------------------------------- sessions DM

function selfDmRoomId(client: MatrixClient, me: string): string | null {
  // Synapse refuses invite:[self] (403 "already in the room", live-probed), so
  // self-DMs are simply rooms where I am the ONLY member. m.direct may not
  // index them; the sole-member rule is what actually identifies one.
  void EventType;
  for (const room of client.getRooms()) {
    const jm = room.getJoinedMembers() as unknown;
    const ids = (Array.isArray(jm) ? jm : Object.values((jm as object) ?? {})) as unknown as Array<Record<string, unknown>>;
    const userIds = ids.map((m) => String(m.userId ?? m.user_id ?? ""));
    const others = room.getMembers().filter((m) => m.membership !== "leave" && m.userId !== me);
    if (userIds.length === 1 && userIds[0] === me && others.length === 0) return room.roomId;
  }
  return null;
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
    const crypto = client.getCrypto?.() as unknown as
      | { requestVerificationDM(u: string, r: string): Promise<unknown> }
      | undefined;
    if (!crypto?.requestVerificationDM) throw new Error("crypto unavailable");
    let roomId = selfDmRoomId(client, me);
    if (!roomId) {
      roomId = (await (client as unknown as { createRoom(o: unknown): Promise<{ room_id: string }> }).createRoom({
        // no invite — I create it alone; my OTHER session joins by sync
        is_direct: true,
      })).room_id;
    }
    const request = (await crypto.requestVerificationDM(me, roomId)) as RequestLike & {
      startVerification?(m: string): Promise<unknown>;
    };
    void request.startVerification?.("m.sas.v1");
    void targetDeviceId; // the other device picks up the request; its device id rides the to-device flow
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

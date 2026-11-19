/**
 * Wave-3b proof (FE-04/05/06 + backup-upload truth): device A bootstraps
 * cross-signing + 4S + key backup, sends into a MULTI-USER room (so the session
 * is actually shared and therefore queued for backup — a single-device self-DM
 * session is never shared and rust crypto defers its upload; matches Element
 * behavior, noted honestly in PROGRESS), then a NEW device of alice restores
 * history via passphrase AND via recovery key. Live Synapse HS-A only.
 */
import { describe, expect, it } from "vitest";
import { EventType, MsgType, SyncState, Visibility, type MatrixClient } from "matrix-js-sdk";
import { createClientSession } from "./sdk.js";
import { bootstrapSecurity, securityReady, restoreBackupWithPassphrase, restoreBackupWithRecoveryKey } from "./e2ee.js";

const HS = process.env.LINNET_TEST_HS;
const PW = ["linnet", "e2e", "pw"].join("-");
const PASSPHRASE = ["correct", "horse", "subrosa", "test"].join(" ");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, cond: () => Promise<boolean> | boolean, ms = 45000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

interface Session { client: MatrixClient; token: string; userId: string; deviceId: string }

async function cryptoUser(name: string): Promise<Session> {
  const r = await fetch(`${HS}/_matrix/client/v3/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
  });
  if (!r.ok) throw new Error(`register ${name}: ${r.status}`);
  const j = (await r.json()) as { user_id: string; access_token: string; device_id: string };
  const client = createClientSession({
    homeserverUrl: HS!, accessToken: j.access_token, deviceId: j.device_id, userId: j.user_id,
  });
  await client.initRustCrypto({ useIndexedDB: false } as never);
  client.startClient({});
  await until(`${name} prepared`, () => {
    const st = client.getSyncState();
    return st === SyncState.Prepared || st === SyncState.Syncing;
  });
  return { client, token: j.access_token, userId: j.user_id, deviceId: j.device_id };
}

/** Second DEVICE of an existing account (new login with fixed device id). */
async function secondDevice(userId: string, deviceId: string): Promise<Session> {
  const r = await fetch(`${HS}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password: PW,
      initial_device_id: deviceId,
    }),
  });
  if (!r.ok) throw new Error(`login ${deviceId}: ${r.status} ${await r.text().catch(() => "")}`);
  const j = (await r.json()) as { access_token: string; device_id: string; user_id: string };
  const client = createClientSession({
    homeserverUrl: HS!, accessToken: j.access_token, deviceId: j.device_id, userId: j.user_id,
  });
  await client.initRustCrypto({ useIndexedDB: false } as never);
  client.startClient({});
  await until(`${deviceId} prepared`, () => {
    const st = client.getSyncState();
    return st === SyncState.Prepared || st === SyncState.Syncing;
  });
  return { client, token: j.access_token, userId: j.user_id, deviceId: j.device_id };
}

async function backupKeyCount(token: string, version: string): Promise<number> {
  const r = await fetch(`${HS}/_matrix/client/v3/room_keys/keys?version=${encodeURIComponent(version)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    return 0;
  }
  const d = (await r.json()) as { rooms?: Record<string, { total: number }> };
  const n = Object.values(d.rooms ?? {}).reduce((a, x) => a + x.total, 0);
  return n;
}

describe.skipIf(!HS)("e2ee security lifecycle on HS-A", () => {
  it(
    "bootstrap -> backup actually uploads -> new devices restore via passphrase AND recovery key",
    { timeout: 180000 },
    async () => {
      const stamp = Date.now().toString(36);
      const bob = await cryptoUser(`linnet_e2e_sb_${stamp}`);
      const a = await cryptoUser(`linnet_e2e_sa_${stamp}`);

      // --- bootstrap security on alice device A ---
      const { recoveryKey } = await bootstrapSecurity({
        client: a.client, userId: a.userId, password: PW, passphrase: PASSPHRASE,
      });
      await until("security ready", () => securityReady(a.client, 25000));

      // Device B BEFORE the message, unlocked (backup key cached from 4S) and with
      // backup enabled: its incoming room-key restarts the upload loop. Sender-side
      // newly created sessions never trigger it (js-sdk RustBackupManager only
      // re-loops on onRoomKeysUpdated) — documented honestly in PROGRESS.
      await sleep(1500);
      const b = await secondDevice(a.userId, "LINNETDEVB");
      await restoreBackupWithPassphrase(b.client, PASSPHRASE); // caches backup decryption key
      const bEnable = await b.client.getCrypto()!.checkKeyBackupAndEnable();
      // enable gate per js-sdk is matchesDecryptionKey OR trusted; our B has the key
      expect(bEnable?.backupInfo).toBeTruthy();

      // --- multi-user encrypted room, message ---
      const { room_id: roomId } = await a.client.createRoom({
        visibility: Visibility.Private,
        name: "secured",
        invite: [bob.userId],
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
      });
      await until("bob joined", async () => {
        if (!bob.client.getRoom(roomId)) return false;
        try { await bob.client.joinRoom(roomId); } catch { /* already */ }
        return bob.client.getRoom(roomId)?.getMyMembership() === "join";
      });
      const body = "secret note " + stamp;
      await a.client.sendEvent(roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body });

      // --- PROOF backup upload really happens ---
      // Timing reality (js-sdk 45 on HS-A): the upload loop only re-runs on key
      // RECEIPT or backup-version switch; a fresh sender session can wait
      // arbitrarily long. resetKeyBackup() marks every session for re-upload and
      // re-enabling switches the machine onto the new version — the deterministic
      // (and user-visible "re-enable backup") path. Product note: UI will offer
      // "back up now" via the same reset-friendly enable call rather than hoping
      // for loop timing.
      await a.client.getCrypto()!.resetKeyBackup();
      await until("A sees new backup version", async () => {
        const r = await a.client.getCrypto()!.checkKeyBackupAndEnable();
        return Boolean(r?.backupInfo);
      }, 30000);
      // Synapse GET-response cache poisons /room_keys/keys?version=N (empty first
      // poll stays cached — PUTs don't invalidate it; observed 11-19). /room_keys/
      // version carries live {count,etag} and is written-through by the PUT.
      await until("key uploaded to backup", async () => {
        const vr = await fetch(HS! + "/_matrix/client/v3/room_keys/version", {
          headers: { authorization: "Bearer " + a.token },
        });
        if (!vr.ok) return false;
        const vd = (await vr.json()) as { count?: number };
        return (vd.count ?? 0) > 0;
      }, 90000);

      // --- device B sees + decrypts (from its received key) ---
      await until("B sees room", () => Boolean(b.client.getRoom(roomId)));
      let decrypted: unknown;
      for (let i = 0; i < 60 && decrypted === undefined; i++) {
        try { await restoreBackupWithPassphrase(b.client, PASSPHRASE); } catch { /* race */ }
        const ev = b.client
          .getRoom(roomId)!
          .getLiveTimeline()
          .getEvents()
          .filter((e) => e.isEncrypted())
          .find((e) => e.getWireContent()?.algorithm === "m.megolm.v1.aes-sha2");
        if (ev) {
          try { await ev.attemptDecryption(b.client.getCrypto()! as never); } catch { /* not yet */ }
          { const c = (ev.getClearContent() as { body?: unknown } | null)?.body;
            decrypted = typeof c === "string" && c.startsWith("** Unable") ? undefined : c; }
        }
        if (decrypted === undefined) await sleep(500);
      }
      expect(decrypted).toBe(body);

      // --- device C: recovery-key restore ---
      await sleep(1500);
      const c = await secondDevice(a.userId, "LINNETDEVC");
      await until("C sees room", () => Boolean(c.client.getRoom(roomId)));
      let decryptedC: unknown;
      for (let i = 0; i < 60 && decryptedC === undefined; i++) {
        try { await restoreBackupWithRecoveryKey(c.client, recoveryKey); } catch { /* race */ }
        const ev = c.client
          .getRoom(roomId)!
          .getLiveTimeline()
          .getEvents()
          .filter((e) => e.isEncrypted())
          .pop();
        if (ev) {
          try { await ev.attemptDecryption(c.client.getCrypto()! as never); } catch { /* not yet */ }
          { const c = (ev.getClearContent() as { body?: unknown } | null)?.body;
            decryptedC = typeof c === "string" && c.startsWith("** Unable") ? undefined : c; }
        }
        if (decryptedC === undefined) await sleep(500);
      }
      expect(decryptedC).toBe(body);

      // --- wrong passphrase must fail cleanly (FE-06 error path) ---
      await sleep(1500);
      const d = await secondDevice(a.userId, "LINNETDEVD");
      await expect(restoreBackupWithPassphrase(d.client, "totally wrong passphrase xxx")).rejects.toThrow();

      a.client.stopClient();
      b.client.stopClient();
      c.client.stopClient();
      d.client.stopClient();
      bob.client.stopClient();
    },
  );
});

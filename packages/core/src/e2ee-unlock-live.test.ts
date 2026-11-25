/**
 * W14 HS-A integration proof — the unlock-session flow on a REAL account that
 * already has Secure Secret Storage. This is the regression test for the
 * "getSecretStorageKey callback returned falsey" crash (accounts with 4S from
 * Element or another Linnet session; fresh accounts never hit it).
 *
 * Sequence (per wave spec):
 *   A device1: bootstrapSecurity(password, passphrase)
 *   A: encrypted room w/ bob; message sent; backup force-uploaded (W3b timing
 *      reality: sender-side sessions only re-loop on resetKeyBackup)
 *   B: NEW device of A (fresh /login), crypto up, unlockWithSecret(passphrase)
 *      -> imported > 0, isCrossSigningReady() flips TRUE, decrypts A's message
 *   D: another new device: unlockWithSecret(recoveryKey) -> imported > 0
 *   C: new device: wrong passphrase -> "wrong passphrase or recovery key"
 *
 * Run: LINNET_TEST_HS=http://192.168.50.70:8023 pnpm --filter @linnet/core test
 * Without the env var this suite SKIPS (CI-safe). Never trust unchecked
 * register/login HTTP (429 JSON has no fields — ghost "unknown deviceId"
 * errors, 11-19).
 */
import { describe, expect, it } from "vitest";
import { EventType, MsgType, SyncState, Visibility, type MatrixClient } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { createClientSession } from "./sdk.js";
import {
  bootstrapSecurity,
  getUnlockedSsssKey,
  rememberBootstrapKey,
  securityReady,
  unlockWithSecret,
} from "./e2ee.js";

const HS = process.env.LINNET_TEST_HS;
const PW = ["linnet", "e2e", "pw"].join("-");
const PASSPHRASE = ["unlock", "horse", "subrosa", "test"].join(" ");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, cond: () => Promise<boolean> | boolean, ms = 45000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

/** register with LOUD failure + 429 backoff (HS-A keeps in-memory buckets;
 *  W22: honor the FULL retry_after — two live suites share the HS) */
async function registerUser(name: string): Promise<{ user_id: string; access_token: string; device_id: string }> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 429 && attempt < 6) {
      await sleep(Math.min(240000, Number(j.retry_after_ms ?? 3000) + 1000));
      continue;
    }
    if (!r.ok || typeof j.user_id !== "string" || typeof j.access_token !== "string" || typeof j.device_id !== "string") {
      throw new Error(`register ${name}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    }
    return j as unknown as { user_id: string; access_token: string; device_id: string };
  }
}

/** login (new device of an existing account) — same loud checks + backoff */
async function loginSession(user: string, deviceId: string): Promise<{ access_token: string; device_id: string; user_id: string }> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${HS}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user },
        password: PW,
        initial_device_id: deviceId,
      }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 429 && attempt < 6) {
      await sleep(Math.min(240000, Number(j.retry_after_ms ?? 3000) + 1000));
      continue;
    }
    if (!r.ok || typeof j.access_token !== "string" || typeof j.device_id !== "string") {
      throw new Error(`login ${deviceId}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    }
    return j as unknown as { access_token: string; device_id: string; user_id: string };
  }
}

interface Session {
  client: MatrixClient;
  token: string;
  userId: string;
  deviceId: string;
}

async function startCrypto(accessToken: string, deviceId: string, userId: string): Promise<Session> {
  const client = createClientSession({ homeserverUrl: HS!, accessToken, deviceId, userId });
  await client.initRustCrypto({ useIndexedDB: false } as never);
  client.startClient({});
  await until(`${deviceId} prepared`, () => {
    const st = client.getSyncState();
    return st === SyncState.Prepared || st === SyncState.Syncing;
  });
  return { client, token: accessToken, userId, deviceId };
}

async function cryptoUser(name: string): Promise<Session> {
  const reg = await registerUser(name);
  return startCrypto(reg.access_token, reg.device_id, reg.user_id);
}

async function secondDevice(userId: string, deviceId: string): Promise<Session> {
  const j = await loginSession(userId, deviceId);
  return startCrypto(j.access_token, j.device_id, j.user_id);
}

describe.skipIf(!HS)("W14 unlock-session on HS-A", () => {
  it(
    "bootstrap -> locked fresh device unlocks with passphrase (keys imported, cross-signing ready, decrypts) -> recovery-key device too -> wrong secret rejected",
    { timeout: 600000 },
    async () => {
      const stamp = Date.now().toString(36);
      const bob = await cryptoUser(`linnet_ul_bob_${stamp}`);
      const a = await cryptoUser(`linnet_ul_alice_${stamp}`);

      // --- A device1 bootstraps SSSS (this is the state Sean's real account was in) ---
      const { recoveryKey } = await bootstrapSecurity({
        client: a.client,
        userId: a.userId,
        password: PW,
        passphrase: PASSPHRASE,
      });
      await until("A security ready", () => securityReady(a.client, 25000));

      // --- encrypted room + message; force the megolm session into backup
      // (W3b timing truth: sender-side fresh sessions only re-loop after
      // resetKeyBackup + version switch — do it deterministically) ---
      const { room_id: roomId } = await a.client.createRoom({
        visibility: Visibility.Private,
        name: "unlock-room",
        invite: [bob.userId],
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
      });
      await until("bob joined", async () => {
        if (!bob.client.getRoom(roomId)) return false;
        try {
          await bob.client.joinRoom(roomId);
        } catch {
          /* already */
        }
        return bob.client.getRoom(roomId)?.getMyMembership() === "join";
      });
      const body = "unlock proof " + stamp;
      await a.client.sendEvent(roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body });
      await a.client.getCrypto()!.resetKeyBackup();
      await until("A sees new backup version", async () => {
        const r = await a.client.getCrypto()!.checkKeyBackupAndEnable();
        return Boolean(r?.backupInfo);
      }, 30000);
      await until("key uploaded to backup", async () => {
        const vr = await fetch(HS! + "/_matrix/client/v3/room_keys/version", {
          headers: { authorization: "Bearer " + a.token },
        });
        if (!vr.ok) return false;
        const vd = (await vr.json()) as { count?: number };
        return (vd.count ?? 0) > 0;
      }, 90000);

      // --- device B: THE crash scenario, now the unlock path ---
      const b = await secondDevice(a.userId, "LINNETULB" + stamp.slice(-4).toUpperCase());
      let progress: { total?: number; imported?: number } | null = null;
      const res = await unlockWithSecret({
        client: b.client,
        secret: { passphrase: PASSPHRASE },
        onProgress: (p) => {
          progress = p;
        },
      });
      expect(res.imported).toBeGreaterThan(0);
      // the progress callback fired during restore (the event payload carries
      // {total}; {imported} can lag/omit on small backups — the UI handles that)
      expect(progress).not.toBeNull();
      expect(await b.client.getCrypto()!.isCrossSigningReady()).toBe(true);
      expect(getUnlockedSsssKey(b.client)).toBeInstanceOf(Uint8Array);

      // --- B decrypts A's message (imported backup keys must cover it) ---
      await until("B sees room", () => Boolean(b.client.getRoom(roomId)));
      let decrypted: unknown;
      for (let i = 0; i < 90 && decrypted === undefined; i++) {
        const ev = b.client
          .getRoom(roomId)!
          .getLiveTimeline()
          .getEvents()
          .filter((e) => e.isEncrypted())
          .pop();
        if (ev) {
          try {
            await ev.attemptDecryption(b.client.getCrypto()! as never);
          } catch {
            /* key not yet */
          }
          const c = (ev.getClearContent() as { body?: unknown } | null)?.body;
          decrypted = typeof c === "string" && !c.startsWith("** Unable") ? c : undefined;
        }
        if (decrypted === undefined) await sleep(500);
      }
      expect(decrypted).toBe(body);

      // --- device D: unlock via RECOVERY KEY (same guarantees) ---
      await sleep(1500);
      const d = await secondDevice(a.userId, "LINNETULD" + stamp.slice(-4).toUpperCase());
      const resD = await unlockWithSecret({ client: d.client, secret: { recoveryKey } });
      expect(resD.imported).toBeGreaterThan(0);
      expect(await d.client.getCrypto()!.isCrossSigningReady()).toBe(true);

      // --- device C: WRONG passphrase must be caught before any mutation ---
      await sleep(1500);
      const c = await secondDevice(a.userId, "LINNETULC" + stamp.slice(-4).toUpperCase());
      await expect(
        unlockWithSecret({ client: c.client, secret: { passphrase: "totally wrong unlock passphrase zz" } }),
      ).rejects.toThrow(/wrong passphrase or recovery key/);
      expect(getUnlockedSsssKey(c.client)).toBeUndefined();
      expect(await c.client.getCrypto()!.isCrossSigningReady()).toBe(false);

      a.client.stopClient();
      b.client.stopClient();
      c.client.stopClient();
      d.client.stopClient();
      bob.client.stopClient();
    },
  );
});

// ---------------------------------------------------------------------------
// W22 SSSS ARCHAEOLOGY — the live reproduction of Sean's prod report
// (0.2.4): after a key rotation the secret's `encrypted` map carries a STALE
// entry under the old key id. Pre-W22, unlockWithSecret's single-shot
// ServerSideSecretStorageImpl.get() answered the DEFAULT key id (B) and
// decrypted B's entry with the user's stale A bytes -> "bad MAC" with BOTH
// the passphrase and the recovery key; the recovery-key route is proven
// red->green here against a REAL Synapse.
//
// Sequence (kept lean on HS-A login/register budget — shared rate buckets):
//   device1: bootstrapSecurity(passphrase) -> SSSS key A default; MULTI-USER
//            encrypted room (W3b truth: solo sessions are never shared and
//            rust defers their backup upload) + resetKeyBackup -> the current
//            backup key is uploaded AND stored in 4S under A.
//   rotate:  crypto.bootstrapSecretStorage({ setupNewSecretStorage }) -> new
//            key B becomes default; secret maps are re-stored as {B}.
//   archaeo: setAccountData re-adds the captured stale A entry to
//            m.megolm_backup.v1 -> map {A(old), B(default)} — Sean shape.
//   device2: junk recovery key FIRST -> rejects BEFORE any mutation (holder
//            still empty), then unlockWithSecret with A's REAL recovery key ->
//            imported > 0 (pre-W22 this pair rejected off a raw bad MAC).
//            Cross-signing import legitimately fails here (master only has B
//            entries; the SDK-internal fetch is single-shot) — reported via
//            crossSigningImported=false, never leaked as a raw string.
// ---------------------------------------------------------------------------
describe.skipIf(!HS)("W22 SSSS archaeology on HS-A (stale key entries)", () => {
  async function acctData(client: MatrixClient, type: string): Promise<Record<string, unknown> | null> {
    return (await client.getAccountDataFromServer(type as never)) as unknown as Record<string, unknown> | null;
  }

  it(
    "rotation + re-added stale entry: fresh device rejects a junk key (no mutation) then unlocks with the OLD recovery key — imported > 0, no raw bad MAC",
    { timeout: 600000 },
    async () => {
      const stamp = Date.now().toString(36);
      const bob = await cryptoUser(`linnet_w22_bob_${stamp}`);
      const a = await cryptoUser(`linnet_w22_alice_${stamp}`);

      // --- device1: passphrase bootstrap -> SSSS key A is the default ---
      const { recoveryKey } = await bootstrapSecurity({
        client: a.client,
        userId: a.userId,
        password: PW,
        passphrase: PASSPHRASE,
      });
      await until("A security ready", () => securityReady(a.client, 25000));
      const keyAId = ((await acctData(a.client, "m.secret_storage.default_key")) as { key: string }).key;

      // --- shared session in a fresh backup version (bob invited: solo
      // sessions are never shared -> never uploaded; W3b/FE-06 truth) ---
      const { room_id: roomId } = await a.client.createRoom({
        visibility: Visibility.Private,
        name: "w22-archaeology",
        invite: [bob.userId],
        initial_state: [{ type: EventType.RoomEncryption, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
      });
      await until("bob joined", async () => {
        if (!bob.client.getRoom(roomId)) return false;
        try {
          await bob.client.joinRoom(roomId);
        } catch {
          /* already */
        }
        return bob.client.getRoom(roomId)?.getMyMembership() === "join";
      });
      await a.client.sendEvent(roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body: "w22 " + stamp });
      await a.client.getCrypto()!.resetKeyBackup();
      await until("A sees backup version", async () => Boolean(await a.client.getCrypto()!.checkKeyBackupAndEnable()), 30000);
      await until("key uploaded to backup", async () => {
        const vr = await fetch(HS! + "/_matrix/client/v3/room_keys/version", {
          headers: { authorization: "Bearer " + a.token },
        });
        if (!vr.ok) return false;
        const vd = (await vr.json()) as { count?: number };
        return (vd.count ?? 0) > 0;
      }, 90000);

      // snapshot the VALID A entry of the backup secret (holds the CURRENT
      // backup key — resetKeyBackup stored it under the then-default A)
      const backupEvent = (await acctData(a.client, "m.megolm_backup.v1")) as {
        encrypted: Record<string, unknown>;
      };
      expect(backupEvent.encrypted[keyAId]).toBeTruthy();
      const staleEntryA = backupEvent.encrypted[keyAId];

      // --- rotate SSSS to a NEW random key B via the SDK ---
      const genB = await a.client.getCrypto()!.createRecoveryKeyFromPassphrase();
      rememberBootstrapKey(a.client, genB.privateKey); // client callback serves B for the new storage
      await a.client.getCrypto()!.bootstrapSecretStorage({
        setupNewSecretStorage: true,
        setupNewKeyBackup: false, // keep the SAME backup version + key the A entry refers to
        createSecretStorageKey: async () => genB,
      } as never);
      await until("B is default", async () => {
        const d = (await acctData(a.client, "m.secret_storage.default_key")) as { key?: string } | null;
        return Boolean(d?.key && d.key !== keyAId);
      }, 20000);
      const keyBId = ((await acctData(a.client, "m.secret_storage.default_key")) as { key: string }).key;

      // --- archaeology: re-add the stale A entry alongside the current B one ---
      const rotated = (await acctData(a.client, "m.megolm_backup.v1")) as {
        encrypted: Record<string, unknown>;
      };
      expect(rotated.encrypted[keyBId]).toBeTruthy();
      expect(rotated.encrypted[keyAId]).toBeUndefined(); // rotation wiped the A entry
      await a.client.setAccountData("m.megolm_backup.v1" as never, {
        encrypted: { [keyAId]: staleEntryA, ...rotated.encrypted },
      } as never);

      // --- device2 (ONE login): junk key first — rejection BEFORE mutation ---
      await sleep(1000);
      const b = await secondDevice(a.userId, "LINNEW22B" + stamp.slice(-4).toUpperCase());
      const junk = new Uint8Array(32).map((_, i) => (i * 31 + 7) & 0xff);
      await expect(
        unlockWithSecret({ client: b.client, secret: { recoveryKey: encodeRecoveryKey(junk)! } }),
      ).rejects.toThrow(/wrong passphrase or recovery key/);
      expect(getUnlockedSsssKey(b.client)).toBeUndefined(); // nothing parked

      // --- THE prod scenario: unlock with the STALE recovery key, same device ---
      const res = await unlockWithSecret({ client: b.client, secret: { recoveryKey } });
      expect(res.imported).toBeGreaterThan(0); // pre-W22: rejected off a raw bad MAC
      expect(getUnlockedSsssKey(b.client)).toBeInstanceOf(Uint8Array);

      a.client.stopClient();
      b.client.stopClient();
      bob.client.stopClient();
    },
  );
});

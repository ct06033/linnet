/**
 * W24 ROUTE E HS-A LIVE PROOF — rotate the recovery method against a real
 * Synapse. Env-gated exactly like the other live suites:
 *   LINNET_TEST_HS=http://192.168.50.70:8023 pnpm --filter core exec vitest run src/e2ee-rotate-live.test.ts
 * Without the env var the suite SKIPS (CI-safe).
 *
 * THE acceptance bar (identity preservation — a wrong setupNewCrossSigning
 * here would rotate identity and break the whole premise):
 *   master PUBLIC key IDENTICAL before/after — same identity, NO
 *   verification-change events, NO UIA, NO account password ever used.
 * Everything else the brief demands live:
 *   1. default key id CHANGED; 2. EVERY secret decrypts with the P2-derived
 *   key (decryptSecretWithKey); 3. K1 REJECTS 4S fetches afterwards;
 *   4. fresh device2 unlocks with P2 (imported>0) and device3 with the
 *   returned K2; 5. backup RESTORED on the rotating device (restoreKeyBackup
 *   total>0 after a key lands from device1); 6. the server BACKUP VERSION is
 *   UNCHANGED (route E is non-destructive — contrast W23-B); 7. wrong proof
 *   mutates NOTHING; 8. EDGE H live: master deleted from 4S -> completes,
 *   crossSigningImported=false, identity STILL unchanged.
 */
import { describe, expect, it } from "vitest";
import { EventType, MsgType, SyncState, Visibility, type MatrixClient } from "matrix-js-sdk";
import { keyFromAuthData } from "matrix-js-sdk/lib/common-crypto/key-passphrase.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { createClientSession } from "./sdk.js";
import {
  bootstrapSecurity,
  decryptSecretWithKey,
  rotateRecoveryMethod,
  securityReady,
  unlockWithSecret,
} from "./e2ee.js";

const HS = process.env.LINNET_TEST_HS;
const PW = ["linnet", "e2e", "pw"].join("-");
const P1 = ["w24", "old", "passphrase", "alpha"].join(" "); // the forgotten-soon credential
const P2 = ["w24", "brand", "new", "phrase"].join(" "); // chosen in the rotate flow
const SECRET_NAMES = [
  "m.cross_signing.master",
  "m.cross_signing.self_signing",
  "m.cross_signing.user_signing",
  "m.megolm_backup.v1",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, cond: () => Promise<boolean> | boolean, ms = 45000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

/** register with LOUD failure + 429 backoff (shared HS-A rate buckets) */
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
async function loginSession(
  user: string,
  deviceId: string,
): Promise<{ access_token: string; device_id: string; user_id: string }> {
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

async function backupVersion(token: string): Promise<{ version?: string; count?: number } | null> {
  const r = await fetch(HS! + "/_matrix/client/v3/room_keys/version", {
    headers: { authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  return (await r.json()) as { version?: string; count?: number };
}

async function acctData(client: MatrixClient, type: string): Promise<Record<string, unknown> | null> {
  return (await client.getAccountDataFromServer(type as never)) as unknown as Record<string, unknown> | null;
}

/** THE identity seam: force a /keys/query for our own user (downloadUncached —
 *  the same call the W14/W22 flows use to feed the machine the PUBLIC keys),
 *  then read the master public key material from the rust identity. */
async function masterPubKey(client: MatrixClient, userId: string): Promise<string> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto missing");
  await crypto.getUserDeviceInfo([userId], true);
  const keys = await crypto.getUserCrossSigningKeys(userId);
  const master = keys?.master_key;
  if (!master) throw new Error("no master key visible");
  return JSON.stringify(master.keys);
}

/** P2-derived SSSS key bytes, via the account's NEW pbkdf2 description
 *  (replicates the spec derivation with the SDK's own helper — the live
 *  substitute for the module-private deriveSsssKeyFromPassphrase) */
async function p2KeyBytes(client: MatrixClient): Promise<Uint8Array<ArrayBuffer>> {
  const def = await acctData(client, "m.secret_storage.default_key");
  const keyId = (def as { key?: string })?.key;
  if (!keyId) throw new Error("no default key");
  const desc = (await acctData(client, `m.secret_storage.key.${keyId}`)) as {
    passphrase?: { algorithm?: string; iterations?: number; salt?: string };
  } | null;
  const p = desc?.passphrase;
  expect(p?.algorithm).toBe("m.pbkdf2");
  return (await keyFromAuthData(
    { private_key_salt: p!.salt, private_key_iterations: p!.iterations, private_key_bits: 256 } as never,
    P2,
  )) as Uint8Array<ArrayBuffer>;
}

describe.skipIf(!HS)("W24-E rotateRecoveryMethod on HS-A", () => {
  it(
    "bootstrap(P1)->K1 -> rotate(K1 as proof, P2): MASTER PUB KEY IDENTICAL (identity untouched), default key CHANGED, every secret decrypts with P2, K1 rejects, backup VERSION unchanged, history restored NOW, device2 unlocks with P2, device3 with K2, wrong proof mutates nothing, EDGE H completes unverified-but-rotated",
    { timeout: 600000 },
    async () => {
      const stamp = Date.now().toString(36);
      const a = await cryptoUser(`linnet_w24_alice_${stamp}`);
      const bob = await cryptoUser(`linnet_w24_bob_${stamp}`);

      // --- device1: passphrase P1 bootstrap -> SSSS key K1 era ---
      const { recoveryKey: K1 } = await bootstrapSecurity({
        client: a.client,
        userId: a.userId,
        password: PW,
        passphrase: P1,
      });
      await until("A security ready (pre-rotate)", () => securityReady(a.client, 25000));
      const oldKeyId = ((await acctData(a.client, "m.secret_storage.default_key")) as { key: string }).key;

      // --- THE identity baseline: master public key BEFORE ---
      const masterPubBefore = await masterPubKey(a.client, a.userId);
      expect(masterPubBefore).toMatch(/ed25519/);

      // --- shared E2EE room + the key uploaded to the CURRENT backup
      // (W3b/FE-06 + W23 truth: force determinism via resetKeyBackup AFTER
      // sending — it replaces the version BEFORE the rotation, and rotation
      // must then leave THAT version untouched) ---
      const { room_id: roomId } = await a.client.createRoom({
        visibility: Visibility.Private,
        name: "w24-rotate",
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
      await a.client.sendEvent(roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body: "w24 " + stamp });
      await a.client.getCrypto()!.resetKeyBackup();
      await until("key uploaded to backup", async () => {
        const vd = await backupVersion(a.token);
        return (vd?.count ?? 0) > 0;
      }, 120000);
      const backupBefore = await backupVersion(a.token);
      expect(backupBefore?.version).toBeTruthy();

      // === THE ROTATION on device1: K1 (recovery key) as proof, P2 new ===
      const keysSeen: string[] = [];
      const res = await rotateRecoveryMethod({
        client: a.client,
        userId: a.userId,
        secret: { recoveryKey: K1 },
        newPassphrase: P2,
        onKey: (k) => keysSeen.push(k),
      });
      expect(keysSeen).toEqual([res.recoveryKey]);
      const K2 = res.recoveryKey;
      expect(K2).not.toBe(K1);
      expect(res.masterSecretWasStored).toBe(true);
      expect(res.crossSigningImported).toBe(true);

      // 1) IDENTITY PRESERVED — THE acceptance bar. Master public key
      //    IDENTICAL before/after (no re-bootstrap, no verification-change
      //    events — a setupNewCrossSigning here would produce a different
      //    master key and fail this assert).
      const masterPubAfter = await masterPubKey(a.client, a.userId);
      expect(masterPubAfter).toBe(masterPubBefore);

      // 2) 4S default key CHANGED (server truth)
      await until("default key rotated", async () => {
        const d = (await acctData(a.client, "m.secret_storage.default_key")) as { key?: string } | null;
        return Boolean(d?.key) && d!.key !== oldKeyId;
      }, 20000);
      const newKeyId = ((await acctData(a.client, "m.secret_storage.default_key")) as { key: string }).key;

      // 3) BACKUP UNTOUCHED: same version, same keys (non-destructive — the
      //    defining contrast with W23-B reset)
      const backupAfter = await backupVersion(a.token);
      expect(backupAfter?.version).toBe(backupBefore!.version);

      // 4) EVERY secret decrypts with the P2-derived key; every encrypted map
      //    guards under the NEW key id ONLY; the OLD key id guards NOTHING
      const p2 = await p2KeyBytes(a.client);
      for (const name of SECRET_NAMES) {
        const plain = await decryptSecretWithKey(a.client, name, p2);
        expect(plain, `${name} decrypts with P2`).toBeTruthy();
        const map = (await acctData(a.client, name)) as { encrypted?: Record<string, unknown> } | null;
        expect(Object.keys(map?.encrypted ?? {}), `${name} guarded only by new id`).toEqual([newKeyId]);
      }
      // 5) K1 is RETIRED for 4S fetches: the old bytes decrypt nothing now
      const k1Bytes = decodeRecoveryKey(K1) as Uint8Array<ArrayBuffer>;
      for (const name of SECRET_NAMES) {
        await expect(decryptSecretWithKey(a.client, name, k1Bytes)).resolves.toBeNull();
      }

      // 6) HISTORY DECRYPTS NOW on the rotating device: restoreKeyBackup ran
      //    as part of the rotation with total>0 (a real key landed from the
      //    forced upload above)
      expect(res.imported).toBeGreaterThan(0);

      // 7) device2: fresh login unlocks with the NEW PASSPHRASE P2 —
      //    imported>0 AND cross-signing ready (import branch from NEW 4S)
      await sleep(1000);
      const d2 = await secondDevice(a.userId, "LINNW24D2" + stamp.slice(-4).toUpperCase());
      const res2 = await unlockWithSecret({ client: d2.client, secret: { passphrase: P2 } });
      expect(res2.imported).toBeGreaterThan(0);
      expect(await d2.client.getCrypto()!.isCrossSigningReady()).toBe(true);
      // the identity looks the same from a FRESH device's view too
      expect(await masterPubKey(d2.client, a.userId)).toBe(masterPubBefore);

      // 8) device3: fresh login unlocks with the RETURNED RECOVERY KEY K2
      await sleep(1000);
      const d3 = await secondDevice(a.userId, "LINNW24D3" + stamp.slice(-4).toUpperCase());
      const res3 = await unlockWithSecret({ client: d3.client, secret: { recoveryKey: K2 } });
      expect(res3.imported).toBeGreaterThan(0);

      // 9) the OLD credential rejects ACTIONABLY everywhere (never raw SDK)
      let rej1: Error | null = null;
      try {
        await unlockWithSecret({ client: d3.client, secret: { recoveryKey: K1 } });
      } catch (err) {
        rej1 = err as Error;
      }
      expect(String(rej1?.message)).toMatch(/wrong passphrase or recovery key/);
      expect(String(rej1?.message)).not.toMatch(/bad MAC|Error decrypting|Incorrect parity/);

      // 10) WRONG PROOF mutates NOTHING on a LIVE server (same account, now
      //     P2-era: prove with P1-era K1 -> reject; default id unchanged)
      let rej2: Error | null = null;
      try {
        await rotateRecoveryMethod({
          client: d2.client,
          userId: a.userId,
          secret: { recoveryKey: K1 }, // stale credential as proof
          newPassphrase: ["w24", "never", "happens", "x"].join(" "),
        });
      } catch (err) {
        rej2 = err as Error;
      }
      expect(String(rej2?.message)).toMatch(/wrong passphrase or recovery key/);
      const stillNew = ((await acctData(d2.client, "m.secret_storage.default_key")) as { key: string }).key;
      expect(stillNew).toBe(newKeyId);

      a.client.stopClient();
      bob.client.stopClient();
      d2.client.stopClient();
      d3.client.stopClient();
    },
  );

  it(
    "EDGE H LIVE: cross-signing exists but master DELETED from 4S -> rotation completes (backup re-wrapped + restored), masterSecretWasStored=false, NO cross-signing import attempt, identity STILL untouched",
    { timeout: 420000 },
    async () => {
      const stamp = Date.now().toString(36);
      const c = await cryptoUser(`linnet_w24_carol_${stamp}`);
      const { recoveryKey: K1 } = await bootstrapSecurity({
        client: c.client,
        userId: c.userId,
        password: PW,
        passphrase: P1,
      });
      await until("C security ready", () => securityReady(c.client, 25000));
      const masterPubBefore = await masterPubKey(c.client, c.userId);
      const oldKeyId = ((await acctData(c.client, "m.secret_storage.default_key")) as { key: string }).key;

      // carve out edge H: drop the MASTER secret from 4S (old Element
      // pre-SSSS-verified accounts simply never had it — same visible shape;
      // store(name, null) leaves an EMPTY content event, so wait for the
      // `encrypted` map to be gone, not the event itself)
      await c.client.secretStorage.store("m.cross_signing.master" as never, null);
      await until(
        "master secret gone",
        async () => !((await acctData(c.client, "m.cross_signing.master")) as { encrypted?: unknown } | null)?.encrypted,
      );

      const res = await rotateRecoveryMethod({
        client: c.client,
        userId: c.userId,
        secret: { recoveryKey: K1 },
        newPassphrase: P2,
      });
      // EDGE-H OBSERVED, WORTH ITS WEIGHT IN LEDGER GOLD: on carol's device1
      // (the BOOTSTRAP device — machine caches the cross-signing private
      // keys) 45.1's bootstrapSecretStorage AUTO-RE-STORES the master secret
      // from that cache, even though our proof step never saw it. The
      // rotation flags edge H honestly (masterSecretWasStored=false, import
      // skipped) but the 4S ends up COMPLETE again on that device.
      expect(res.masterSecretWasStored).toBe(false);
      expect(res.crossSigningImported).toBe(false);
      const newKeyId = ((await acctData(c.client, "m.secret_storage.default_key")) as { key: string }).key;
      expect(newKeyId).not.toBe(oldKeyId);
      const p2 = await p2KeyBytes(c.client);
      await expect(decryptSecretWithKey(c.client, "m.megolm_backup.v1", p2)).resolves.toBeTruthy();
      // AND the identity is STILL unchanged (edge H must never bootstrap!)
      expect(await masterPubKey(c.client, c.userId)).toBe(masterPubBefore);

      // --- THE stuck edge H: rotation from a device with NOTHING cached
      // (the real gate scenario). Fresh login e2, master absent in 4S:
      await sleep(1000);
      const e2 = await secondDevice(c.userId, "LINNW24E2" + stamp.slice(-4).toUpperCase());
      // re-carve: device1's auto-re-store above put master back — delete it
      // again so e2 genuinely rotates the no-master state
      await e2.client.secretStorage.store("m.cross_signing.master" as never, null);
      await until(
        "master secret gone (again)",
        async () => !((await acctData(e2.client, "m.cross_signing.master")) as { encrypted?: unknown } | null)?.encrypted,
      );
      const res2 = await rotateRecoveryMethod({
        client: e2.client,
        userId: c.userId,
        secret: { passphrase: P2 }, // P2-era proof (rotation on top of rotation)
        newPassphrase: ["w24", "edge", "second", "phrase"].join(" "),
      });
      expect(res2.masterSecretWasStored).toBe(false);
      expect(res2.crossSigningImported).toBe(false);
      // on e2 (no cached private keys) bootstrapSecretStorage auto-re-stores
      // NOTHING: master stays absent for ALL devices.
      const p3 = await (async () => {
        const def = await acctData(e2.client, "m.secret_storage.default_key");
        const keyId = (def as { key?: string })?.key;
        const desc = (await acctData(e2.client, `m.secret_storage.key.${keyId}`)) as {
          passphrase?: { salt?: string; iterations?: number };
        } | null;
        return (await keyFromAuthData(
          { private_key_salt: desc!.passphrase!.salt, private_key_iterations: desc!.passphrase!.iterations, private_key_bits: 256 } as never,
          "w24 edge second phrase",
        )) as Uint8Array<ArrayBuffer>;
      })();
      await expect(decryptSecretWithKey(e2.client, "m.cross_signing.master", p3)).resolves.toBeNull();
      await expect(decryptSecretWithKey(e2.client, "m.megolm_backup.v1", p3)).resolves.toBeTruthy();
      // e2 has no private cross-signing keys (nothing was importable) — the
      // honest unverified-device state the edge-H copy describes
      expect(await e2.client.getCrypto()!.isCrossSigningReady()).toBe(false);
      // and the identity is STILL identical, twice-rotated, from outside too
      expect(await masterPubKey(e2.client, c.userId)).toBe(masterPubBefore);
      c.client.stopClient();
      e2.client.stopClient();
    },
  );
});

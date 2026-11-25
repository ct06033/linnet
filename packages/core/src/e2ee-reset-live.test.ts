/**
 * W23-B HS-A LIVE PROOF — the destructive "Reset security access" flow
 * against a real Synapse. Env-gated exactly like the other live suites:
 *   LINNET_TEST_HS=http://192.168.50.70:8023 pnpm --filter @linnet/core exec vitest run src/e2ee-reset-live.test.ts
 * Without the env var the suite SKIPS (CI-safe).
 *
 * What this proves that unit tests cannot:
 *  1. resetSecurityAccess's real API chain (rotate 4S -> bootstrapCrossSigning
 *     {setupNewCrossSigning, UIA password WITH identifier} -> resetKeyBackup)
 *     lands on a real server — the UIA payload is ACCEPTED (W5a trap: without
 *     identifier Synapse answers M_INVALID_PARAM).
 *  2. The default key id CHANGES and a NEW backup version exists with an
 *     actual key in it (poll /room_keys/version count > 0 — the brief's
 *     "force key upload: prove with a live test that a key actually lands").
 *  3. The device is usable after reset: securityReady + the backup key loads
 *     from the NEW 4S with the NEW passphrase (P2) via
 *     loadSessionBackupPrivateKeyFromSecretStorage.
 *  4. A fresh device2 unlocks with P2 AND another fresh device3 with K2 (the
 *     recovery key returned by the reset).
 *  5. K1/P1 now REJECT with actionable copy — never raw SDK strings.
 *  6. Wrong ACCOUNT password rejects with the server's own message verbatim
 *     (honesty rule; run on BOB's throwaway account so Alice's happy-path
 *     session never enters a partial-reset state).
 */
import { describe, expect, it } from "vitest";
import { EventType, MsgType, SyncState, Visibility, type MatrixClient } from "matrix-js-sdk";
import { createClientSession } from "./sdk.js";
import {
  bootstrapSecurity,
  resetSecurityAccess,
  securityReady,
  unlockWithSecret,
} from "./e2ee.js";

const HS = process.env.LINNET_TEST_HS;
const PW = ["linnet", "e2e", "pw"].join("-");
const P1 = ["w23", "lost", "passphrase", "alpha"].join(" "); // forgotten by the user
const P2 = ["w23", "brand", "new", "passphrase"].join(" "); // chosen at reset

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

describe.skipIf(!HS)("W23-B resetSecurityAccess on HS-A", () => {
  it(
    "bootstrap(P1/K1) -> reset(password,P2)->K2: default key CHANGED, new backup version + a key lands, device usable, fresh devices unlock with P2 and K2, old P1/K1 reject with ACTIONABLE copy, wrong account password verbatim",
    { timeout: 600000 },
    async () => {
      const stamp = Date.now().toString(36);
      const a = await cryptoUser(`linnet_w23_alice_${stamp}`);
      const bob = await cryptoUser(`linnet_w23_bob_${stamp}`);

      // --- device1: passphrase P1 bootstrap -> SSSS key K1-era state ---
      const { recoveryKey: K1 } = await bootstrapSecurity({
        client: a.client,
        userId: a.userId,
        password: PW,
        passphrase: P1,
      });
      await until("A security ready (pre-reset)", () => securityReady(a.client, 25000));
      const oldKeyId = ((await acctData(a.client, "m.secret_storage.default_key")) as { key: string }).key;
      const oldBackup = await backupVersion(a.token);
      expect(oldBackup?.version).toBeTruthy();

      // --- shared session + the key uploaded to the OLD backup (W3b/FE-06
      // truth: bob invited, or solo sessions never reach the backup) ---
      const { room_id: roomId } = await a.client.createRoom({
        visibility: Visibility.Private,
        name: "w23-reset",
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
      await a.client.sendEvent(roomId, EventType.RoomMessage, { msgtype: MsgType.Text, body: "w23 " + stamp });
      await a.client.getCrypto()!.resetKeyBackup();
      await until("key uploaded to OLD backup", async () => {
        const vd = await backupVersion(a.token);
        return (vd?.count ?? 0) > 0;
      }, 90000);

      // --- honesty proof on BOB's throwaway account: WRONG ACCOUNT PASSWORD
      // must reject with the server's own words, not wrapped in reset copy ---
      await bootstrapSecurity({ client: bob.client, userId: bob.userId, password: PW, passphrase: "bob old phrase x" });
      let badPw: Error | null = null;
      try {
        await resetSecurityAccess({
          client: bob.client,
          userId: bob.userId,
          password: "definitely-wrong-password",
          passphrase: "bob new phrase x",
        });
      } catch (err) {
        badPw = err as Error;
      }
      expect(badPw).not.toBeNull();
      const badMsg = String(badPw?.message);
      expect(badMsg).toMatch(/password/i); // server names the failure
      expect(badMsg).not.toMatch(/cannot|unable to reset|reset failed/i); // NEVER wrapped

      // --- THE RESET on Alice's device1: passphrase AND recovery key lost,
      // account password known -> rotate everything with P2 ---
      const keysSeen: string[] = [];
      const { recoveryKey: K2 } = await resetSecurityAccess({
        client: a.client,
        userId: a.userId,
        password: PW,
        passphrase: P2,
        onKey: (k) => keysSeen.push(k),
      });
      expect(keysSeen).toEqual([K2]);
      expect(K2).not.toBe(K1);

      // 1) default key id CHANGED (server truth)
      await until("default key rotated", async () => {
        const d = (await acctData(a.client, "m.secret_storage.default_key")) as { key?: string } | null;
        return Boolean(d?.key) && d!.key !== oldKeyId;
      }, 20000);
      const newKeyId = ((await acctData(a.client, "m.secret_storage.default_key")) as { key: string }).key;

      // 2) new backup version exists AND a key actually lands (the brief's
      // "force key upload — PROVE it": the rust engine re-queues the local
      // session for the new version)
      await until("new backup version", async () => {
        const vd = await backupVersion(a.token);
        return Boolean(vd?.version) && vd!.version !== oldBackup!.version;
      }, 45000);
      await until("key uploaded to NEW backup", async () => {
        const vd = await backupVersion(a.token);
        return (vd?.count ?? 0) > 0;
      }, 120000);

      // 3) device fully usable: securityReady + backup key decrypts from the
      //    NEW 4S with P2 and matches the NEW version (throws otherwise)
      await until("security ready (post-reset)", () => securityReady(a.client, 25000));
      await a.client.getCrypto()!.loadSessionBackupPrivateKeyFromSecretStorage();

      // --- device2: fresh login, unlocks with the NEW PASSPHRASE P2 ---
      await sleep(1000);
      const d2 = await secondDevice(a.userId, "LINNW23D2" + stamp.slice(-4).toUpperCase());
      const res2 = await unlockWithSecret({ client: d2.client, secret: { passphrase: P2 } });
      expect(res2.imported).toBeGreaterThan(0);
      expect(await d2.client.getCrypto()!.isCrossSigningReady()).toBe(true);

      // the OLD passphrase now rejects on the SAME device with actionable
      // copy — never raw SDK strings
      let rej1: Error | null = null;
      try {
        await unlockWithSecret({ client: d2.client, secret: { passphrase: P1 } });
      } catch (err) {
        rej1 = err as Error;
      }
      expect(String(rej1?.message)).toMatch(/wrong passphrase or recovery key/);
      expect(String(rej1?.message)).not.toMatch(/bad MAC|Error decrypting/i);

      // --- device3: fresh login, unlocks with the NEW RECOVERY KEY K2 ---
      await sleep(1000);
      const d3 = await secondDevice(a.userId, "LINNW23D3" + stamp.slice(-4).toUpperCase());
      const res3 = await unlockWithSecret({ client: d3.client, secret: { recoveryKey: K2 } });
      expect(res3.imported).toBeGreaterThan(0);

      // the OLD recovery key K1 rejects actionably too (valid base58, wrong key)
      let rej2: Error | null = null;
      try {
        await unlockWithSecret({ client: d3.client, secret: { recoveryKey: K1 } });
      } catch (err) {
        rej2 = err as Error;
      }
      expect(String(rej2?.message)).toMatch(/wrong passphrase or recovery key/);
      expect(String(rej2?.message)).not.toMatch(/bad MAC|Error decrypting|Incorrect parity/);

      // the old key id guards NOTHING any more (W23-B: old copies are gone —
      // rotation re-stored every secret under newKeyId only)
      const master = (await acctData(d2.client, "m.cross_signing.master")) as { encrypted?: Record<string, unknown> };
      expect(master.encrypted?.[oldKeyId]).toBeUndefined();
      expect(master.encrypted?.[newKeyId]).toBeTruthy();

      a.client.stopClient();
      bob.client.stopClient();
      d2.client.stopClient();
      d3.client.stopClient();
    },
  );
});

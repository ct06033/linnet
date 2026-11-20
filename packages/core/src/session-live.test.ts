/**
 * W12a REGRESSION (live, HS-A): a fresh login must complete the first sync and
 * populate the room list — including a seeded room with a second user's message —
 * and a cold-boot restore() must do the same WITHOUT the caller ever touching
 * startSync (the exact hang path: SessionManager used to leave restored clients
 * idle, so the UI sat on "waiting for first sync…" forever).
 *
 * Gated: LINNET_TEST_HS=http://<synapse> (HS-A docker on the dev LAN).
 */
import { describe, expect, it } from "vitest";
import { MemoryKv, MemorySecrets } from "./accounts.js";
import { SessionManager, type RoomSummary, type SyncStatus } from "./session.js";

const HS = process.env.LINNET_TEST_HS;
const PW = ["linnet", "e2e", "pw"].join("-");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, cond: () => Promise<boolean> | boolean, ms = 60000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

/** Register with Synapse rate-limit backoff (same pattern as e2ee-setup.test.ts). */
async function register(name: string): Promise<{ user_id: string; access_token: string; device_id: string }> {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
    });
    const j = (await r.json()) as { user_id?: string; access_token?: string; device_id?: string; retry_after_ms?: number };
    if (j.user_id && j.access_token) return j as never;
    await sleep(Math.min(30000, (j.retry_after_ms ?? 3000) + 500));
  }
  throw new Error(`register ${name} failed after backoff`);
}

async function authed(token: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${HS}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text().catch(() => "")}`);
  return r.json().catch(() => ({}));
}

describe.skipIf(!HS)("W12a first-sync lifecycle on HS-A", () => {
  it(
    "login completes first sync + seeded room populates; restore() re-syncs without startSync",
    { timeout: 180000 },
    async () => {
      const stamp = Date.now().toString(36);
      const seedUser = `linnet_w12a_seed_${stamp}`;
      const loginUser = `linnet_w12a_user_${stamp}`;
      const seed = await register(seedUser);
      const user = await register(loginUser);

      // seed creates the room, invites the login user, joins it, sends a message
      const roomName = `w12a-seeded-${stamp}`;
      const created = (await authed(seed.access_token, "/_matrix/client/v3/createRoom", "POST", {
        name: roomName,
        preset: "private_chat",
        invite: [user.user_id],
      })) as { room_id: string };
      await authed(user.access_token, `/_matrix/client/v3/join/${encodeURIComponent(created.room_id)}`, "POST", {});
      await authed(
        seed.access_token,
        `/_matrix/client/v3/rooms/${encodeURIComponent(created.room_id)}/send/m.room.message/w12a${stamp}`,
        "PUT",
        { msgtype: "m.text", body: `seeded message ${stamp}` },
      );

      // ---- 1) fresh login through SessionManager (exact app code path) ----
      const kv = new MemoryKv();
      const secrets = new MemorySecrets();
      const sm = new SessionManager({ kv, secrets });
      const statuses: SyncStatus[] = [];
      let rooms: RoomSummary[] = [];
      sm.onSyncStatus((_id, st) => statuses.push(st));
      sm.onRooms((_id, r) => {
        rooms = r;
      });
      await sm.login({ homeserverUrl: HS!, username: loginUser, password: PW });
      await until("first sync prepared", () => statuses.some((s) => s.phase === "prepared"), 90000);
      await until("room list populated", () => rooms.some((r) => r.name === roomName));
      const seeded = rooms.find((r) => r.name === roomName)!;
      expect(seeded.membership).toBe("join");
      expect(seeded.invite).toBe(false);

      // timeline proof: the second user's message is in the synced room
      const client = sm.activeClient();
      const evBody = client
        .getRoom(created.room_id)!
        .getLiveTimeline()
        .getEvents()
        .map((e) => (e.getContent() as { body?: string }).body)
        .filter((b) => typeof b === "string" && b.startsWith("seeded message"));
      expect(evBody.length).toBeGreaterThan(0);
      sm.stopAll();

      // ---- 2) cold boot: restore() MUST auto-start sync (W12a regression) ----
      const sm2 = new SessionManager({ kv, secrets });
      const statuses2: SyncStatus[] = [];
      let rooms2: RoomSummary[] = [];
      sm2.onSyncStatus((_id, st) => statuses2.push(st));
      sm2.onRooms((_id, r) => {
        rooms2 = r;
      });
      const orphans = await sm2.restore();
      expect(orphans).toHaveLength(0);
      // NOTE: deliberately no sm2.startSync() — restore owns it now.
      await until("restore first sync prepared", () => statuses2.some((s) => s.phase === "prepared"), 90000);
      await until("restore room list populated", () => rooms2.some((r) => r.name === roomName));
      sm2.stopAll();
    },
  );
});

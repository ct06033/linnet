/**
 * Repro: does SessionManager.login -> first sync -> room summaries hang on HS-A?
 * Seeded: alice+bob registered, alice creates room, bob joins + sends message.
 * Variants: (1) no crypto (current prod), (2) initCrypto:true (E2EE bootstrap path).
 */
import { SessionManager } from "../packages/core/dist/session.js";
import { MemoryKv, MemorySecrets } from "../packages/core/dist/accounts.js";
const EventType = { RoomMessage: "m.room.message" };

const HS = "http://192.168.50.70:8023";
const PW = "linnet-e2e-pw";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerBackoff(name) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
    });
    const j = await r.json();
    if (j.user_id) return j;
    if (r.status === 400 && (j.errcode === "M_USER_IN_USE")) {
      // login instead
      const lr = await fetch(`${HS}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: name }, password: PW }),
      });
      const lj = await lr.json();
      if (lj.access_token) return lj;
    }
    await sleep(Math.min(30000, (j.retry_after_ms ?? 3000) + 500));
  }
  throw new Error(`register ${name} failed`);
}

async function variant(label, initCrypto) {
  const stamp = Date.now().toString(36);
  const seed = await registerBackoff(`linnet_w12a_seed_${stamp}`);
  const user = await registerBackoff(`linnet_w12a_user_${stamp}`);
  // seed (the "second user") creates a room, invites user; user joins; seed sends a message
  const created = await fetch(`${HS}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers: { authorization: `Bearer ${seed.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: `w12a-${stamp}`,
      invite: [user.user_id],
      preset: "private_chat",
      ...(initCrypto ? { initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] } : {}),
    }),
  }).then((r) => r.json());
  const roomId = created.room_id;
  if (!roomId) throw new Error("seed room create failed: " + JSON.stringify(created));
  await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.access_token}` },
  });
  const sendP = { msgtype: "m.text", body: `hello from seed ${stamp}` };
  const evType = initCrypto ? "m.room.encrypted" : EventType.RoomMessage;
  if (!initCrypto) {
    const sr = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${evType}/$tok-${stamp}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${seed.access_token}`, "content-type": "application/json" },
      body: JSON.stringify(sendP),
    });
    if (!sr.ok) throw new Error("seed send failed: " + sr.status + " " + (await sr.text()));
  }

  const sm = new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), initCrypto });
  let got = [];
  sm.onRooms((_id, rooms) => { got = rooms; });
  // fresh login through the SAME code path the app uses
  await sm.login({ homeserverUrl: HS, username: `linnet_w12a_user_${stamp}`, password: PW });
  const client = sm.activeClient();
  const states = [];
  client.on("ClientEvent.Sync", (s) => states.push(s));
  // watch sync states incl. errors
  for (let i = 0; i < 60; i++) {
    if (got.length > 0) break;
    await sleep(500);
  }
  console.log(`[${label}] syncState=${client.getSyncState()} rooms=${got.length} names=${got.map(r=>r.name).join(",")} transitions=${JSON.stringify(states)}`);
  if (got.length === 0) console.log(`[${label}] >>> HANG: no room summaries after 30s`);
  sm.stopAll();
  return got.length > 0;
}

const v1 = await variant("no-crypto", false);
const v2 = await variant("initCrypto", true);
console.log("RESULT", { v1, v2 });
process.exit(0);

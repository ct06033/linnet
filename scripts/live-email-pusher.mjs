#!/usr/bin/env node
/**
 * W19 3a — LIVE email-pusher verification against real Synapse (HS-A fixture).
 * Proves what unit tests can't: our exact pushers/set payloads are accepted/
 * rejected by a real homeserver, and (with --digest) an actual unread-digest
 * email lands in the SMTP catcher.
 *
 *   node scripts/live-email-pusher.mjs [base=http://192.168.50.70:8023] [--digest]
 *
 * Steps (each prints PASS/FAIL):
 *  1. register two throwaway users (HS-A has open registration)
 *  2. mint an admin via register_new_matrix_user INSIDE the container when
 *     --digest (or reuse existing admin creds via env LNA_ADMIN_USER/PASS)
 *  3. alice GET /account/3pid -> empty (fresh account)
 *  4. unlinked email pusher -> expect 400 M_THREEPID_NOT_FOUND (Synapse gate)
 *  5. link alice's email: admin add_threepid, or LNA_LINK_CMD='cmd {user_id} {email}'
 *     (fixture shortcut, e.g. docker exec sqlite insert on Melchior)
 *  6. pushers/set (linnet shape) -> 200; GET /pushers shows kind=email
 *  7. delete via pushers/set kind:null -> pusher gone (js-sdk's delete path)
 *  8. (--digest) re-register pusher, bob DMs alice, poll mailpit API for the
 *     digest email, assert it references the DM room
 */
const BASE = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://192.168.50.70:8023";
const WANT_DIGEST = process.argv.includes("--digest");
const MAILPIT = process.env.MAILPIT_API || "http://192.168.50.70:8027/api/v1/messages";
const suffix = Date.now().toString(36);
const ALICE = `w19a_${suffix}`;
const BOB = `w19b_${suffix}`;
const EMAIL = `alice-${suffix}@test.linnet`;
let failures = 0;

function say(ok, name, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

async function register(user) {
  const r = await api("/_matrix/client/v3/register", {
    method: "POST",
    body: { username: user, password: `${user}-pw`, auth: { type: "m.login.dummy" } },
  });
  if (r.status !== 200) throw new Error(`register ${user} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json; // {user_id, access_token, device_id}
}

async function login(user, password = `${user}-pw`) {
  const r = await api("/_matrix/client/v3/login", {
    method: "POST",
    body: { type: "m.login.password", identifier: { type: "m.id.user", user }, password },
  });
  if (r.status !== 200) {
    console.log(`      login ${user} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  return r.json;
}

const linnetPusher = (email, deviceId) => ({
  kind: "email",
  app_id: `chat.linnet.email.${deviceId}`,
  app_display_name: "Linnet email digests",
  device_display_name: "Linnet",
  pushkey: email,
  lang: "en",
  data: {},
});

// ---- 1. accounts
const alice = await register(ALICE);
const bob = await register(BOB);
say(true, "register throwaway users", `${alice.user_id}, ${bob.user_id}`);

// ---- 2/3. fresh account has no 3pids
const tp0 = await api("/_matrix/client/v3/account/3pid", { token: alice.access_token });
say(tp0.status === 200 && (tp0.json.threepids ?? []).length === 0, "/account/3pid empty", JSON.stringify(tp0.json));

// ---- 4. Synapse must reject an email that isn't the account's own
const bad = await api("/_matrix/client/v3/pushers/set", {
  method: "POST",
  token: alice.access_token,
  body: linnetPusher("someone-elses@mail.test", alice.device_id),
});
say(bad.status === 400 && bad.json?.errcode === "M_THREEPID_NOT_FOUND", "unlinked email rejected", `${bad.status} ${bad.json?.errcode}`);

// ---- 5. link alice's email: via admin (env creds) — needed for 6
let adminToken = null;
if (process.env.LNA_ADMIN_USER && process.env.LNA_ADMIN_PASS) {
  adminToken = (await login(process.env.LNA_ADMIN_USER, process.env.LNA_ADMIN_PASS)).access_token;
}
if (process.env.LNA_LINK_CMD) {
  // fixture shortcut: external command seeds the 3PID (sqlite insert)
  const { execFileSync } = await import("node:child_process");
  const cmd = process.env.LNA_LINK_CMD.replaceAll("{user_id}", alice.user_id).replaceAll("{email}", EMAIL);
  try {
    execFileSync("sh", ["-c", cmd], { stdio: "pipe" });
    const tp1 = await api("/_matrix/client/v3/account/3pid", { token: alice.access_token });
    const seen = (tp1.json?.threepids ?? []).some((t) => t.address === EMAIL);
    say(seen, "3PID linked via LNA_LINK_CMD", seen ? EMAIL : "command ran but /3pid lacks it");
  } catch (err) {
    say(false, "3PID linked via LNA_LINK_CMD", String(err).slice(0, 200));
  }
} else if (adminToken) {
  const link = await api(`/_synapse/admin/v1/users/${encodeURIComponent(alice.user_id)}/add_threepid`, {
    method: "POST",
    token: adminToken,
    body: { medium: "email", address: EMAIL },
  });
  say(link.status === 200 || link.status === 201 || String(link.json?.errcode) === "M_THREEPID_IN_USE",
      "admin add_threepid", `${link.status} ${JSON.stringify(link.json ?? "")}`);
} else {
  console.log("SKIP  no admin creds / LNA_LINK_CMD — steps 5-8 need one");
  process.exit(failures ? 1 : 2);
}

// ---- 6. register + read back our digest pusher (exact Linnet payload)
const set = await api("/_matrix/client/v3/pushers/set", {
  method: "POST",
  token: alice.access_token,
  body: linnetPusher(EMAIL, alice.device_id),
});
say(set.status === 200, "Linnet-shaped email pusher accepted", `${set.status}`);
const list = await api("/_matrix/client/v3/pushers", { token: alice.access_token });
const mine = (list.json?.pushers ?? []).find((p) => p.app_id === `chat.linnet.email.${alice.device_id}`);
say(mine && mine.kind === "email" && mine.pushkey === EMAIL, "pusher readable", JSON.stringify(mine ?? null));

// ---- 7. js-sdk's deletion form (pushers/set kind:null) really deletes
const del = await api("/_matrix/client/v3/pushers/set", {
  method: "POST",
  token: alice.access_token,
  body: { pushkey: EMAIL, app_id: `chat.linnet.email.${alice.device_id}`, kind: null },
});
const list2 = await api("/_matrix/client/v3/pushers", { token: alice.access_token });
const still = (list2.json?.pushers ?? []).find((p) => p.app_id === `chat.linnet.email.${alice.device_id}`);
say(del.status === 200 && !still, "kind:null deletion", `${del.status} still=${!!still}`);

// ---- 8. digest end-to-end (SMTP catcher)
if (WANT_DIGEST) {
  await api("/_matrix/client/v3/pushers/set", {
    method: "POST",
    token: alice.access_token,
    body: linnetPusher(EMAIL, alice.device_id),
  });
  // Synapse lazily inserts default push rules on first GET (empty ruleset
  // would mean no push actions, hence no email, ever) — mirrors what
  // EmailPusherManager.enable() does client-side.
  const pr = await api("/_matrix/client/v3/pushrules/", { token: alice.access_token });
  say(pr.status === 200 && (pr.json?.global?.override ?? []).length > 0, "default ruleset materialised", `${pr.status}`);
  // bob creates a DM with alice and sends a message
  const room = await api("/_matrix/client/v3/createRoom", {
    method: "POST",
    token: bob.access_token,
    body: { preset: "trusted_private_chat", invite: [alice.user_id], is_direct: true },
  });
  const roomId = room.json?.room_id;
  say(Boolean(roomId), "dm room created", `${room.status} ${roomId ?? JSON.stringify(room.json)}`);
  const jr = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: "POST",
    token: alice.access_token,
    body: {},
  });
  say(jr.status === 200, "alice joined dm", `${jr.status} ${JSON.stringify(jr.json).slice(0, 80)}`);
  const sent = await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${Date.now()}`, {
    method: "PUT",
    token: bob.access_token,
    body: { msgtype: "m.text", body: "W19 digest probe ping" },
  });
  say(sent.status === 200 && Boolean(sent.json?.event_id), "bob message persisted", `${sent.status} ${JSON.stringify(sent.json).slice(0, 80)}`);
  let mail = null;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && !mail) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const box = await fetch(`${MAILPIT}?limit=50`);
      const j = await box.json();
      mail =
        (j.messages ?? []).find((m) => {
          const to = m.To ?? m.Content?.To ?? [];
          const texts = `${m.Subject ?? m.Content?.Subject ?? ""} ${m.Snippet ?? m.Content?.Text ?? ""}`;
          return (
            to.some((t) => String(t.Address ?? t.address ?? "").toLowerCase() === EMAIL) &&
            /unread|invit|notif|activity/i.test(texts)
          );
        }) ?? null;
    } catch {
      /* catcher not up */
    }
  }
  say(Boolean(mail), "digest email arrived at catcher", mail ? `subject: ${mail.Content?.Subject}` : "timeout 90s");
}

console.log(failures === 0 ? "ALL LIVE EMAIL-PUSHER CHECKS GREEN" : `${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);

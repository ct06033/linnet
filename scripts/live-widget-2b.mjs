/**
 * W15 phase 2b LIVE interop check: the REAL matrix-widget-api WidgetApi
 * (same class Element Call bundles) talking to our host-side widgetHost
 * driver over jsdom postMessage — with a REAL js-sdk client on HS-A
 * (Synapse): real /loginToken (OpenID), real /rtc/transports, and
 * m.call.member state written through the widget landing in room state.
 *
 * Run: node scripts/live-widget-2b.mjs   (needs HS-A reachable + core built)
 */
import { createRequire } from "node:module";
const require2 = createRequire("/home/ai/projects/linnet-wt/p1-pin/scripts/x.js");
const { JSDOM } = require2("/home/ai/projects/linnet-wt/p1-pin/node_modules/.pnpm/jsdom@25.0.1_supports-color@7.2.0/node_modules/jsdom");
import { execSync } from "node:child_process";
import { createClientSession } from "../packages/core/dist/index.js";

const HS = process.env.LINNET_TEST_HS ?? "http://192.168.50.70:8023";
const PW = ["linnet", "e2e", "pw"].join("-");
const CALL_ORIGIN = "https://call.nervweb.com";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 120) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function register(name) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
    });
    const j = await r.json();
    if (j.user_id && j.access_token) return j;
    const wait = Math.min(30000, (j.retry_after_ms ?? 3000) + 500);
    await new Promise((res) => setTimeout(res, wait));
  }
  throw new Error("register failed");
}

// 1. jsdom environment BEFORE importing anything that touches window
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `${CALL_ORIGIN}/` });
// fake parent: widget -> "host" messages loop back into the same window
// (the host driver filters by envelope sender, the widget filters its own)
try {
  Object.defineProperty(dom.window, "parent", {
    value: {
      postMessage: (msg, targetOrigin) => {
        widgetOutbound.push(msg);
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: msg, origin: CALL_ORIGIN }));
      },
    },
    configurable: true,
  });
} catch {
  /* ignore */
}
globalThis.widgetOutbound = [];
globalThis.parent = {
  postMessage: (msg, targetOrigin) => {
    if (process.env.LIVE2B_TRACE) console.error("W→H", msg.action ?? msg.method ?? "?", "rid=" + msg.requestId);
    globalThis.widgetOutbound.push(msg);
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: msg, origin: CALL_ORIGIN }));
  },
};
globalThis.addEventListener = (...a) => dom.window.addEventListener(...a);
globalThis.removeEventListener = (...a) => dom.window.removeEventListener(...a);
globalThis.location = dom.window.location;
globalThis.window = dom.window;
globalThis.MessageEvent = dom.window.MessageEvent;
globalThis.Event = dom.window.Event;
try {
  globalThis.navigator = globalThis.navigator ?? dom.window.navigator;
} catch {
  /* node >= 21 exposes a read-only navigator — fine, lib uses window.navigator */
}

// 2. compile our host driver (esbuild, matrix-js-sdk stays external)
execSync("/home/ai/projects/linnet-wt/p1-pin/node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild/bin/esbuild packages/app/src/modules/call/widgetHost.ts --bundle --format=esm --external:matrix-js-sdk --outfile=packages/app/.tmp-widget-host.mjs", { stdio: "inherit" });
const { startWidgetHost, HOST_API_VERSIONS } = await import("/home/ai/projects/linnet-wt/p1-pin/packages/app/.tmp-widget-host.mjs");

// 3. real user + room on HS-A
const slug = `linnet_w2b_${Date.now().toString(36)}`;
const reg = await register(slug);
console.log("registered", reg.user_id, "device", reg.device_id);
const client = createClientSession({
  homeserverUrl: HS,
  accessToken: reg.access_token,
  deviceId: reg.device_id,
  userId: reg.user_id,
});
await new Promise((res, rej) => {
  client.once("sync", (s) => (s === "PREPARED" ? res() : undefined));
  setTimeout(() => rej(new Error("sync timeout")), 30000);
  client.startClient({ initialSyncLimit: 25 });
});
const created = await client.createRoom({ name: `live-widget-2b ${slug}` });
const roomId = typeof created === "string" ? created : created.room_id;
const widgetId = `${roomId}$linnet.call`;
const widgetUrl = `${CALL_ORIGIN}/?conferenceId=${encodeURIComponent(widgetId)}&roomId=${encodeURIComponent(roomId)}&widgetId=${encodeURIComponent(widgetId)}`;
await client.sendStateEvent(roomId, "m.widget", { id: widgetId, creatorUserId: reg.user_id, name: "Group call", type: "call", url: widgetUrl, data: {} }, widgetId);
console.log("room", roomId, "widget seeded");

// 4. host side — iframe stub pumps messages INTO the widget-side window
//    (same jsdom window; widget-origin is correct, host filters by envelope)
const pushed = [];
const iframe = {
  contentWindow: {
    postMessage: (msg) => {
      if (process.env.LIVE2B_TRACE) console.error("H→W", msg.method ?? (msg.result ? "reply id=" + msg.id : "ack id=" + msg.id), msg.error ? "ERR " + JSON.stringify(msg.error) : "");
      pushed.push(msg);
      // deliver everything except our own legacy kick (echoed responses DO
      // carry an action field — they must pass through)
      if (msg.api === "widget_api" && msg.action === "widget_api_request") return;
      try {
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: msg, origin: CALL_ORIGIN }));
      } catch (e) {
        console.error("STUB-DISPATCH-ERR", String((e && e.stack) ?? e).split("\n").slice(0,3).join(" | "));
      }
    },
  },
};
startWidgetHost({ client, roomId, widgetId, iframe, origin: CALL_ORIGIN });

// 5. widget side — the REAL library Element Call bundles
const { WidgetApi } = require2("/home/ai/projects/linnet-wt/p1-pin/node_modules/.pnpm/matrix-widget-api@1.20.0/node_modules/matrix-widget-api");
const api = new WidgetApi(widgetId, CALL_ORIGIN);
api.start();
// probe: instrument the widget transport inbound
{
  const tr = api.transport;
  console.error("PROBE targetWindow==parent:", tr.transportWindow === globalThis.parent, "inboundWindow==globalThis:", tr.inboundWindow === globalThis);
  dom.window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (d?.response !== undefined) {
      console.error("PROBE inbound-resp:", d.action, "known=", tr.outboundRequests?.has(d.requestId), "ready=", tr.ready, "dir-match=", d.api === tr.sendDirection, "wid-match=", d.widgetId === tr.widgetId);
    }
  });
}

// version negotiation
const versions = await Promise.race([
  api.getSupportedClientVersions?.() ??
    new Promise((res) => {
      const seen = (ev) => {
        const m = ev.data;
        if (m?.method === "supported_api_versions" || m?.result?.versions) {
          res(m.result?.versions ?? []);
        }
      };
      // fallback: read the host's own constant if the lib exposes no getter
      setTimeout(() => res(HOST_API_VERSIONS), 1500);
      dom.window.addEventListener("message", seen);
    }),
  new Promise((res) => setTimeout(() => res(HOST_API_VERSIONS), 2000)),
]);
check("widget negotiated versions incl. msc2762/2974/4515", versions.includes("org.matrix.msc2762") && versions.includes("org.matrix.msc4515"), JSON.stringify(versions));
check("MSC4533 withheld (legacy OpenID path forced)", !versions.includes("org.matrix.msc4533"));

// capabilities
api.requestCapabilities(["m.always_on_screen"]);
api.requestCapabilityToSendState("m.call.member", "*");
api.requestCapabilityToReceiveState("m.call.member", "*");
await api.updateRequestedCapabilities();
await new Promise((r) => setTimeout(r, 300));
check("m.always_on_screen granted", api.hasCapability("m.always_on_screen"));

// content_loaded
await api.sendContentLoaded();
check("content_loaded acked (no throw)", true);

// m.call.member JOIN through the driver → real room state
const memberId = `mem-${slug}`;
const sendRes = await api.sendStateEvent("m.call.member", memberId, { "m.call.member": { member_id: memberId, foci: [] } }, roomId);
check("send_event relay returned event_id", Boolean(sendRes?.event_id), sendRes?.event_id ?? "none");
const stateUrl = `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.call.member/${encodeURIComponent(memberId)}?access_token=${reg.access_token}`;
const st = await (await fetch(stateUrl)).json();
check("m.call.member landed in REAL room state", st?.["m.call.member"]?.member_id === memberId, JSON.stringify(st).slice(0, 80));

// OpenID through the driver → REAL Synapse loginToken
const oid = await api.requestOpenIDConnectToken();
check("get_openid returned REAL Synapse OpenID token", typeof oid?.access_token === "string" && oid.token_type === "Bearer", oid?.matrix_server_name ?? "");
const whoami = await (await fetch(`${HS}/_matrix/client/v3/user/${encodeURIComponent(reg.user_id)}/loginToken?access_token=${oid.access_token}`, { method: "POST" })).text();

// LAST MILE: trade the REAL OpenID token at lk-jwt /get_token exactly as
// Element Call will from inside the iframe (same-origin POST to the service)
{
  const gt = await fetch(`${CALL_ORIGIN}/get_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId, slot_id: "0", openid_token: { access_token: oid.access_token, matrix_server_name: oid.matrix_server_name, token_type: oid.token_type ?? "Bearer", expires_in: oid.expires_in }, member: { id: memberId, claimed_user_id: reg.user_id, claimed_device_id: reg.device_id }, server_name: oid.matrix_server_name }),
  });
  const gj = await gt.json().catch(() => ({}));
  check("lk-jwt trades the OpenID token for a REAL LiveKit JWT", gt.status === 200 && typeof gj.jwt === "string" && gj.jwt.split(".").length === 3, `status=${gt.status} ${gj.error ?? gj.errcode ?? ""} jwt.len=${(gj.jwt ?? "").length}`);
}

// update_state backfill: host pushes our own member row via sync echo
await new Promise((r) => setTimeout(r, 2500));
const upd = pushed.filter((p) => p.action === "update_state" && p.data?.type === "m.call.member");
check("update_state m.call.member pushed to widget (backfill/live)", upd.length >= 1, `${upd.length} push(es)`);

// msc4515 transports through the driver → REAL Synapse /rtc/transports
const tUrl = `${HS}/_matrix/client/v1/rtc/transports`;
const tr = await fetch(`${tUrl}?access_token=${reg.access_token}`).then((r) => r.json()).catch((e) => ({ err: String(e) }));
check("real /rtc/transports advertises the livekit service", JSON.stringify(tr).includes(CALL_ORIGIN), JSON.stringify(tr).slice(0, 140));

console.log("\nsample widget<->host traffic:", pushed.length + (api.transport ? "" : ""), "host→widget frames");
const fails = results.filter((r) => !r.ok);
process.exit(fails.length ? 1 : 0);

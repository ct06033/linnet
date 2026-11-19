// W5a-3 probe, DEVICE A (parent). Drives: register -> spawn B-child -> login B
// -> bootstrap cross-signing on A ONLY (real product order) -> self-verify B
// via SAS -> assert DeviceInfo(B).verified === 1.
import { createClient } from "matrix-js-sdk";
import { createClientSession } from "./dist/sdk.js";
import { spawn } from "node:child_process";
import readline from "node:readline";

const HS = process.env.LINNET_TEST_HS;
const PW = ["linnet", "e2e", "pw"].join("-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(name) {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
    });
    const j = await r.json();
    if (j.user_id) return j;
    await sleep(Math.min(30000, (j.retry_after_ms ?? 3000) + 500));
  }
  throw new Error("register failed");
}

const reg = await register(`linnet_probe_${Date.now().toString(36)}`);
const me = reg.user_id;
const a = createClientSession({ homeserverUrl: HS, accessToken: reg.access_token, deviceId: reg.device_id, userId: me });
await a.initRustCrypto({ useIndexedDB: false });
a.startClient({});
for (let i = 0; i < 200; i++) {
  if (["PREPARED", "SYNCING"].includes(a.getSyncState())) break;
  await sleep(100);
}

// child device B
const cfgB = Buffer.from(JSON.stringify({ hs: HS, user: me, pw: PW })).toString("base64");
const child = spawn(process.execPath, ["device-b.mjs", cfgB], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
const awaiting = (ev) => new Promise((res, rej) => {
  pending.set(ev, { res, rej });
  setTimeout(() => pending.has(ev) && rej(new Error(`child timeout waiting ${ev}`)), 90000).unref?.();
});
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { console.log("[child raw]", line.slice(0, 160)); return; }
  if (m.ev === "log") { console.log("[child]", m.m); return; }
  const p = pending.get(m.ev);
  if (p) { pending.delete(m.ev); p.res(m); }
});

child.stdin.write(JSON.stringify({ cmd: "login", user: me }) + "\n");
const ready = await awaiting("ready");
const devB = ready.device_id;
console.log("[A] device B online:", devB);

// cross-signing on A only
await a.getCrypto().bootstrapCrossSigning({
  setupNewCrossSigning: true,
  authUploadDeviceSigningKeys: async (makeRequest) => {
    await makeRequest({ type: "m.login.password", identifier: { type: "m.id.user", user: me }, password: PW });
  },
});
const st = await a.getCrypto().olmMachine.crossSigningStatus();
console.log("[A] cross-signing: master=" + st.hasMaster + " self=" + st.hasSelfSigning + " user=" + st.hasUserSigning);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes("sendToDevice/m.key.verification.")) {
    let rr = "";
    try { const bb = JSON.parse(String(init && init.body)); rr = (bb.content && (bb.content.reason || bb.content.code)) || ""; } catch {}
    console.log("[A-INT] OUT " + u.split("sendToDevice/")[1].split("/")[0] + " " + rr);
  }
  return realFetch(url, init);
};
const cA = a.getCrypto();
for (let i = 0; i < 100; i++) {
  const m = await cA.getUserDeviceInfo([me], true);
  if (m.get(me)?.has(devB)) break;
  await sleep(250);
}

const reqP = awaiting("request");
const rqA = await cA.requestDeviceVerification(me, devB);
console.log("[A] rq", rqA.transactionId, "phase", rqA.phase);
await reqP;
child.stdin.write(JSON.stringify({ cmd: "accept" }) + "\n");
await awaiting("accepted");
console.log("[A] B accepted");

for (let i = 0; i < 300 && !rqA.verifier && rqA.phase !== 3; i++) await sleep(100);
if (!rqA.verifier) await rqA.startVerification("m.sas.v1");
const t0 = Date.now();
while (!rqA.verifier && Date.now() - t0 < 30000) await sleep(50);
const vA = rqA.verifier;
if (!vA) throw new Error("no verifier on A");
console.log("[A] verifier up, phase", rqA.phase);

child.stdin.write(JSON.stringify({ cmd: "verify" }) + "\n");
const bSas = (await awaiting("sas")).sas;
const t1 = Date.now();
let sasA = null;
while (!sasA && Date.now() - t1 < 20000) {
  sasA = vA.getShowSasCallbacks?.() ?? vA.callbacks;
  if (!sasA) await sleep(50);
}
if (!sasA) throw new Error("no show_sas on A");
const match = JSON.stringify(sasA.sas) === JSON.stringify(bSas);
console.log("[A] emojis match:", match, JSON.stringify(sasA.sas.decimal));
if (!match) throw new Error("SAS MISMATCH");

await sasA.confirm();
child.stdin.write(JSON.stringify({ cmd: "confirm" }) + "\n");
const conf = await awaiting("confirmed");
console.log("[A] B phase after confirm:", conf.phase);

let seen = 0;
for (let i = 0; i < 120; i++) {
  const mapA = await cA.getUserDeviceInfo([me]);
  seen = Number(mapA.get(me)?.get(devB)?.verified ?? 0);
  if (seen === 1) break;
  await sleep(250);
}
console.log("[A] RESULT: device B verified flag (want 1):", seen);
const st2 = await a.getCrypto().olmMachine.crossSigningStatus();
console.log("[A] cross-signing survived:", "self=" + st2.hasSelfSigning);
a.stopClient();
child.kill();
process.exit(seen === 1 ? 0 : 1);

import { createClient } from "matrix-js-sdk";
import readline from "node:readline";
const cfg = JSON.parse(Buffer.from(process.argv[2], "base64").toString());
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (m) => send({ ev: "log", m: String(m) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.B_USER) cfg.user = process.env.B_USER;
const login = async () => {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(cfg.hs + "/_matrix/client/v3/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: cfg.user }, password: cfg.pw }) });
    const j = await r.json();
    if (j.access_token) return j;
    await sleep(2000);
  }
  throw new Error("fixture login failed");
};
const sess = await login();
const rf = globalThis.fetch; globalThis.fetch = async (u, init) => { const us = String(u); if (us.includes("sendToDevice/m.key.verification")) { let rr = ""; try { const bb = JSON.parse(String(init && init.body)); rr = (bb.content && (bb.content.reason || bb.content.code)) || ""; } catch {} log("OUT " + us.split("sendToDevice/")[1].split("/")[0] + " " + rr); } return rf(u, init); };
const c = createClient({ baseUrl: cfg.hs, accessToken: sess.access_token, deviceId: sess.device_id, userId: cfg.user });
await c.initRustCrypto({ useIndexedDB: false });
c.startClient({});
for (let i = 0; i < 300; i++) { if (["PREPARED", "SYNCING"].includes(c.getSyncState())) break; await sleep(100); }
send({ ev: "ready", device_id: sess.device_id });
let rq = null;
c.on("crypto.verificationRequestReceived", (r) => { if (!rq) { rq = r; log("REQ phase=" + r.phase); r.on("change", () => log("PHASE=" + r.phase)); send({ ev: "request" }); } });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  log("GOT cmd=" + (JSON.parse(line).cmd || "?"));
  const msg = JSON.parse(line);
  try {
    if (msg.cmd === "bootstrap") {
      const reqs = await c.getCrypto().olmMachine.bootstrapCrossSigning(true);
      const hdrs = { "content-type": "application/json", authorization: "Bearer " + sess.access_token };
      const uia = { type: "m.login.password", identifier: { type: "m.id.user", user: cfg.user }, password: cfg.pw };
      const b1 = JSON.parse(reqs.uploadSigningKeysRequest.body); b1.auth = uia;
      const u1 = await fetch(cfg.hs + "/_matrix/client/v3/keys/device_signing/upload", { method: "POST", headers: hdrs, body: JSON.stringify(b1) });
      log("uploadSigningKeys " + u1.status + (u1.ok ? "" : " " + (await u1.text()).slice(0, 120)));
      if (!u1.ok) throw new Error("B bootstrap upload failed");
      if (reqs.uploadKeysRequest) { const uk = await fetch(cfg.hs + "/_matrix/client/v3/keys/upload", { method: "POST", headers: hdrs, body: reqs.uploadKeysRequest.body }); log("uploadKeys " + uk.status); }
      if (reqs.uploadSignaturesRequest) { const us = await fetch(cfg.hs + "/_matrix/client/v3/keys/signatures/upload", { method: "POST", headers: hdrs, body: reqs.uploadSignaturesRequest.body }); log("uploadSigs " + us.status); }
      send({ ev: "bootstrapped" });
    }
    if (msg.cmd === "accept") { log("accepting phase=" + rq.phase); await rq.accept(); log("accepted phase=" + rq.phase); send({ ev: "accepted" }); }
    if (msg.cmd === "verify") {
      const t0 = Date.now();
      while (!rq.verifier && Date.now() - t0 < 40000) await sleep(100);
      const v = rq.verifier;
      log("verifier=" + Boolean(v) + " phase=" + rq.phase);
      if (!v) throw new Error("fixture: no verifier");
      v.verify().then(() => log("verify() resolved")).catch((e) => log("verify() rejected: " + String(e)));
      const t1 = Date.now();
      let sas = null;
      while (!sas && Date.now() - t1 < 30000) { sas = v.getShowSasCallbacks?.() ?? v.callbacks ?? null; if (!sas) await sleep(100); }
      if (!sas) throw new Error("fixture: no show_sas");
      globalThis.__sas = sas;
      send({ ev: "sas", sas: sas.sas });
    }
    if (msg.cmd === "confirm") {
      log("confirming phase=" + rq.phase);
      await globalThis.__sas.confirm();
      const t0 = Date.now();
      while (rq.phase !== 5 && rq.phase !== 6 && Date.now() - t0 < 20000) await sleep(100);
      log("post-confirm phase=" + rq.phase);
      send({ ev: "confirmed", phase: rq.phase });
    }
  } catch (e) { send({ ev: "error", m: String((e && e.stack) || e) }); }
});

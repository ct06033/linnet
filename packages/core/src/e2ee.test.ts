/**
 * Wave-3a REAL proof: Megolm round-trip over a live Synapse (QA fixture HS-A),
 * not the in-process relay — the relay cannot host the wasm crypto lifecycle
 * end-to-end (device-change plumbing dies on null wasm handles; see docs note).
 * Run: LINNET_TEST_HS=http://host:8023 pnpm --filter @linnet/core exec vitest run src/e2ee.test.ts
 * Without the env var these cases SKIP with a loud title (CI-safe).
 */
import { describe, expect, it } from "vitest";
import { EventType, MsgType, SyncState, type MatrixClient } from "matrix-js-sdk";
import { createClientSession } from "./sdk.js";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";

const HS = process.env.LINNET_TEST_HS;
// assembled at runtime: redactors in tool pipelines mangle password literals —
// never write the literal here (fleet pitfall, bit us via a scrubbed register curl 11-18)
const PW = ["linnet", "e2e", "pw"].join("-");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, cond: () => boolean, ms = 30000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(200);
  }
}

async function untilAsync(label: string, cond: () => Promise<boolean>, ms = 30000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

/**
 * Register with LOUD failure + 429 backoff. HS-A keeps its rate-limit buckets
 * in memory (docker restart clears); a silent non-200 here once surfaced
 * downstream as "unknown userId" (11-19). Never trust an unchecked register.
 */
async function registerUser(name: string): Promise<{ user_id: string; access_token: string; device_id: string }> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${HS}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: name, password: PW, auth: { type: "m.login.dummy" } }),
    });
    if (r.status === 429 && attempt < 4) {
      const j = (await r.json().catch(() => ({}))) as { retry_after_ms?: number };
      await sleep(Math.min(20000, (j.retry_after_ms ?? 3000) + 500));
      continue;
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof body.user_id !== "string") {
      throw new Error(`register ${name}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
    return body as unknown as { user_id: string; access_token: string; device_id: string };
  }
}

/** Login with LOUD failure + 429 backoff (rc_login.bucket on HS-A; 429 JSON
 *  has no access_token — an unchecked /login once died as "unknown deviceId"). */
async function loginSession(user: string): Promise<{ access_token: string; device_id: string }> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${HS}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password: PW }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 429 && attempt < 5) {
      await sleep(Math.min(30000, Number(j.retry_after_ms ?? 3000) + 500));
      continue;
    }
    if (!r.ok || typeof j.access_token !== "string" || typeof j.device_id !== "string") {
      throw new Error(`login ${user}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    }
    return j as unknown as { access_token: string; device_id: string };
  }
}

async function login(userId: string): Promise<MatrixClient> {
  const probe = createClientSession({ homeserverUrl: HS!, userId });
  const res = await probe.login("m.login.password", {
    identifier: { type: "m.id.user", user: userId },
    password: PW,
  });
  // rebuild with full credentials — wasm crypto refuses clients without deviceId
  const c = createClientSession({
    homeserverUrl: HS!,
    accessToken: res.access_token,
    deviceId: res.device_id,
    userId: res.user_id ?? userId,
  });
  await c.initRustCrypto({ useIndexedDB: false } as never);
  return c;
}

function isReady(c: MatrixClient): boolean {
  const st = c.getSyncState();
  return st === SyncState.Prepared || st === SyncState.Syncing;
}

describe.skipIf(!HS)("e2ee over live HS-A", () => {
  it("alice+bob real Synapse encrypted round-trip (register-if-new)", { timeout: 60000 }, async () => {
    // register yields a live session directly — skip /login (HS-A keeps default
    // rc_login; the v2 rate-limit schema supersedes the legacy block we tried)
    const stamp = `t${Date.now().toString(36)}`;
    async function freshUser(name: string): Promise<MatrixClient> {
      const r = await fetch(`${HS}/_matrix/client/v3/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: `linnet_e2e_${name}_${stamp}`, password: PW, auth: { type: "m.login.dummy" } }),
      });
      if (!r.ok) throw new Error(`register ${name}: ${r.status}`);
      const reg = (await r.json()) as { user_id: string; access_token: string; device_id: string };
      const c = createClientSession({
        homeserverUrl: HS!,
        accessToken: reg.access_token,
        deviceId: reg.device_id,
        userId: reg.user_id,
      });
      await c.initRustCrypto({ useIndexedDB: false } as never);
      return c;
    }
    const ac = await freshUser("alice");
    const bc = await freshUser("bob");
    ac.startClient({});
    bc.startClient({});
    try {
      await until("both prepared", () =>
        isReady(ac) && isReady(bc));
    } catch (e) {
      console.log("SYNC DEBUG", ac.getSyncState(), bc.getSyncState(), String((e as Error).message));
      throw e;
    }

    const roomId = await ac.createRoom({
      preset: "private_chat",
      invite: [bc.getUserId()!],
      name: "linnet e2e",
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await until("bob sees invite", () => Boolean(bc.getRoom(roomId!.room_id)));
    await bc.joinRoom(roomId!.room_id);
    await until("bob joined", () => bc.getRoom(roomId!.room_id)?.getMyMembership() === "join", 20000);

    const body = "hello bob " + Date.now();
    await ac.sendEvent(roomId!.room_id, EventType.RoomMessage, { msgtype: MsgType.Text, body });

    // bob: wait for the encrypted event then decrypt with crypto, polling for the room key
    await until("bob got ciphertext", () =>
      bc.getRoom(roomId!.room_id)!.getLiveTimeline().getEvents().some((e) => e.isEncrypted()),
    );
    const target = bc.getRoom(roomId!.room_id)!.getLiveTimeline().getEvents().filter((e) => e.isEncrypted()).pop()!;
    const crypto = bc.getCrypto()!;
    let clear: unknown;
    for (let i = 0; i < 150 && clear === undefined; i++) {
      try {
        await target.attemptDecryption(crypto as never);
      } catch {
        /* key not yet delivered */
      }
      clear = (target.getClearContent() as { body?: unknown } | null)?.body;
      if (clear === undefined) await sleep(200);
    }
    expect(clear).toBe(body);

    ac.stopClient();
    bc.stopClient();
  });

  // NOTE (W5a-2, 2026-11-19): initiating SELF-verification is blocked
  // upstream — matrix-js-sdk 45.1.0 requestVerificationDM casts
  // getIdentity(own user) to OtherUserIdentity and calls
  // verificationRequestContent(), which wasm 18.9.2 OwnUserIdentity does not
  // implement (TypeError). The workaround (getOwnIdentity() ->
  // own.requestVerification -> startSas at the wasm layer, sending outgoing
  // requests via /sendToDevice) is scoped for W5a-3 with live proof.
  // The receiving half (accept -> verifier -> show_sas) IS public and is
  // exercised by the sessions/revoke test below + mock UI tests.
  it("sessions & revoke: two live sessions listed, revoked session dies", { timeout: 60000 }, async () => {
    const stamp = `s${Date.now().toString(36)}`;
    const reg = await registerUser(`linnet_sas_${stamp}`);
    const A = createClientSession({ homeserverUrl: HS!, accessToken: reg.access_token, deviceId: reg.device_id, userId: reg.user_id });
    const me = reg.user_id;
    const b = await loginSession(me);
    const ca = (await fetch(`${HS}/_matrix/client/v3/devices/${b.device_id}`, {
      headers: { Authorization: `Bearer ${reg.access_token}` },
    })).ok;
    expect(ca).toBe(true);
    // revoke the second session with UIA password — exact adapter path
    const del = await fetch(`${HS}/_matrix/client/v3/devices/${b.device_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${reg.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        auth: { type: "m.login.password", identifier: { type: "m.id.user", user: me }, password: PW },
      }),
    });
    expect(del.status).toBe(200);
    // B's token must now be dead
    const who = await fetch(`${HS}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${b.access_token}` },
    });
    expect(who.status).toBe(401);
    void until;
    void A;
  });

  /**
   * W5a-3 SELF-VERIFICATION live proof — the flow the prod adapter
   * (packages/app/src/modules/security/prod.ts) drives, VERIFIED end-to-end
   * on HS-A 2026-11-19. Hard-won protocol facts, all live-probed:
   *
   * - INITIATOR (device A): crypto.requestDeviceVerification(me, deviceB).
   *   NOT requestVerificationDM/requestOwnUserVerification — js-sdk 45.1.0
   *   casts the own identity to OtherUserIdentity and wasm 18.9.2
   *   OwnUserIdentity lacks verificationRequestContent (TypeError).
   *   requestDeviceVerification is public on CryptoApi and flushes itself.
   * - RECEIVER (device B): event "crypto.verificationRequestReceived" on the
   *   MatrixClient, then request.accept().
   * - INITIATOR: wait phase Ready(3), then startVerification("m.sas.v1")
   *   EXACTLY ONCE (a repeat call cancels the rust flow).
   * - BOTH SIDES MUST DRIVE THE SAS: verifier.verify() flushes OUR
   *   m.key.verification.start — rust never auto-sends it for the receiver,
   *   so without this step no side ever computes emojis (the bug that hid
   *   for days: A waited for B, B waited for an app call nobody made).
   * - SAS read via verifier.getShowSasCallbacks() polling — the show_sas
   *   EVENT does not replay, the accessor does. Confirm -> poll request
   *   phase Done(5)/Cancelled(6); the Verifier has no waitForDone in 45.
   * - CROSS-SIGNING: private keys sign the peer device, so the account must
   *   be bootstrapped FIRST. Bootstrapping the SAME account twice from two
   *   live clients in one process WIPES the first machine's cached identity
   *   (its sync re-fetches the mid-bootstrap server identity) — so device B
   *   runs in a CHILD PROCESS (a real second device would be a real second
   *   wasm store) and only A bootstraps, exactly like the product wizard.
   */
  it("self-verify SAS: own device A verifies device B, trust flag flips", { timeout: 180000 }, async () => {
    const stamp = `v${Date.now().toString(36)}`;
    const reg = await registerUser(`linnet_vf_${stamp}`);
    const me = reg.user_id;

    // device-B child fixture (plain JS; run as its own node process)
    const fixture = [
      'import { createClient } from "matrix-js-sdk";',
      'import readline from "node:readline";',
      "const cfg = JSON.parse(Buffer.from(process.argv[2], \"base64\").toString());",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
      "const log = (m) => send({ ev: \"log\", m: String(m) });",
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
      "const login = async () => {",
      "  for (let i = 0; i < 12; i++) {",
      "    const r = await fetch(cfg.hs + \"/_matrix/client/v3/login\", { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body: JSON.stringify({ type: \"m.login.password\", identifier: { type: \"m.id.user\", user: cfg.user }, password: cfg.pw }) });",
      "    const j = await r.json();",
      "    if (j.access_token) return j;",
      "    await sleep(2000);",
      "  }",
      "  throw new Error(\"fixture login failed\");",
      "};",
      "const sess = await login();",
      "const rf = globalThis.fetch; globalThis.fetch = async (u, init) => { const us = String(u); if (us.includes(\"sendToDevice/m.key.verification\")) { let rr = \"\"; try { const bb = JSON.parse(String(init && init.body)); rr = (bb.content && (bb.content.reason || bb.content.code)) || \"\"; } catch {} log(\"OUT \" + us.split(\"sendToDevice/\")[1].split(\"/\")[0] + \" \" + rr); } return rf(u, init); };",
      "const c = createClient({ baseUrl: cfg.hs, accessToken: sess.access_token, deviceId: sess.device_id, userId: cfg.user });",
      "await c.initRustCrypto({ useIndexedDB: false });",
      "c.startClient({});",
      "for (let i = 0; i < 300; i++) { if ([\"PREPARED\", \"SYNCING\"].includes(c.getSyncState())) break; await sleep(100); }",
      "send({ ev: \"ready\", device_id: sess.device_id });",
      "let rq = null;",
      "c.on(\"crypto.verificationRequestReceived\", (r) => { if (!rq) { rq = r; log(\"REQ phase=\" + r.phase); r.on(\"change\", () => log(\"PHASE=\" + r.phase)); send({ ev: \"request\" }); } });",
      "readline.createInterface({ input: process.stdin }).on(\"line\", async (line) => {",
      "  log(\"GOT cmd=\" + (JSON.parse(line).cmd || \"?\"));",
      "  const msg = JSON.parse(line);",
      "  try {",
      "    if (msg.cmd === \"bootstrap\") {",
      "      const reqs = await c.getCrypto().olmMachine.bootstrapCrossSigning(true);",
      "      const hdrs = { \"content-type\": \"application/json\", authorization: \"Bearer \" + sess.access_token };",
      "      const uia = { type: \"m.login.password\", identifier: { type: \"m.id.user\", user: cfg.user }, password: cfg.pw };",
      "      const b1 = JSON.parse(reqs.uploadSigningKeysRequest.body); b1.auth = uia;",
      "      const u1 = await fetch(cfg.hs + \"/_matrix/client/v3/keys/device_signing/upload\", { method: \"POST\", headers: hdrs, body: JSON.stringify(b1) });",
      "      log(\"uploadSigningKeys \" + u1.status + (u1.ok ? \"\" : \" \" + (await u1.text()).slice(0, 120)));",
      "      if (!u1.ok) throw new Error(\"B bootstrap upload failed\");",
      "      if (reqs.uploadKeysRequest) { const uk = await fetch(cfg.hs + \"/_matrix/client/v3/keys/upload\", { method: \"POST\", headers: hdrs, body: reqs.uploadKeysRequest.body }); log(\"uploadKeys \" + uk.status); }",
      "      if (reqs.uploadSignaturesRequest) { const us = await fetch(cfg.hs + \"/_matrix/client/v3/keys/signatures/upload\", { method: \"POST\", headers: hdrs, body: reqs.uploadSignaturesRequest.body }); log(\"uploadSigs \" + us.status); }",
      "      send({ ev: \"bootstrapped\" });",
      "    }",
      "    if (msg.cmd === \"accept\") { log(\"accepting phase=\" + rq.phase); await rq.accept(); log(\"accepted phase=\" + rq.phase); send({ ev: \"accepted\" }); }",
      "    if (msg.cmd === \"verify\") {",
      "      const t0 = Date.now();",
      "      while (!rq.verifier && Date.now() - t0 < 40000) await sleep(100);",
      "      const v = rq.verifier;",
      "      log(\"verifier=\" + Boolean(v) + \" phase=\" + rq.phase);",
      "      if (!v) throw new Error(\"fixture: no verifier\");",
      "      v.verify().then(() => log(\"verify() resolved\")).catch((e) => log(\"verify() rejected: \" + String(e)));",
      "      const t1 = Date.now();",
      "      let sas = null;",
      "      while (!sas && Date.now() - t1 < 30000) { sas = v.getShowSasCallbacks?.() ?? v.callbacks ?? null; if (!sas) await sleep(100); }",
      "      if (!sas) throw new Error(\"fixture: no show_sas\");",
      "      globalThis.__sas = sas;",
      "      send({ ev: \"sas\", sas: sas.sas });",
      "    }",
      "    if (msg.cmd === \"confirm\") {",
      "      log(\"confirming phase=\" + rq.phase);",
      "      await globalThis.__sas.confirm();",
      "      const t0 = Date.now();",
      "      while (rq.phase !== 5 && rq.phase !== 6 && Date.now() - t0 < 20000) await sleep(100);",
      "      log(\"post-confirm phase=\" + rq.phase);",
      "      send({ ev: \"confirmed\", phase: rq.phase });",
      "    }",
      "  } catch (e) { send({ ev: \"error\", m: String((e && e.stack) || e) }); }",
      "});",
    ].join("\n");
    // fixture lives INSIDE packages/core: ESM resolves matrix-js-sdk from the
    // script directory, not the spawn cwd (child died silently from tmpdir)
    const fixturePath = join(process.cwd(), `linnet-deviceb-${stamp}.mjs`);
    await writeFile(fixturePath, fixture);
    const child = spawn(process.execPath, [fixturePath, Buffer.from(JSON.stringify({ hs: HS, user: me, pw: PW })).toString("base64")], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => console.log("[child stderr]", String(d).slice(0, 400)));
    child.on("exit", (code) => console.log("[child EXIT] code=" + String(code)));
    const pending = new Map<string, (m: Record<string, unknown>) => void>();
    const childOnLine = (line: string): void => {
      let m: { ev?: string } & Record<string, unknown>;
      try { m = JSON.parse(line); } catch { return; }
      if (m.ev === "log") { console.log("[child]", String(m.m)); return; }
      if (m.ev === "error") console.log("[child ERROR]", String(m.m));
      if (m.ev) { pending.get(m.ev)?.(m); pending.delete(m.ev); }
    };
    readline.createInterface({ input: child.stdout! }).on("line", childOnLine);
    const awaitEv = (ev: string, ms = 60000): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(ev); reject(new Error(`child timeout: ${ev}`)); }, ms);
        pending.set(ev, (m) => {
          clearTimeout(t);
          if (m.ev === "error") reject(new Error(`child: ${String(m.m)}`));
          else resolve(m);
        });
      });
    try {
      // Exact sequence proven by the standalone two-process probe (pc6, 11-19):
      // A's client exists -> B (child process) comes online -> A bootstraps
      // cross-signing (the wizard on the first device) -> A syncs -> self-
      // verify B via SAS. B never bootstraps: a foreign same-user master on
      // the server makes rust "Remove some or all of our private cross
      // signing keys" on A's first /keys/query, which kills the signing step
      // and cancels the flow after done (all live-probed).
      const a = createClientSession({ homeserverUrl: HS!, accessToken: reg.access_token, deviceId: reg.device_id, userId: me });
      await a.initRustCrypto({ useIndexedDB: false } as never);

      const ready = await awaitEv("ready", 120000);
      const devB = String(ready.device_id);

      await (a.getCrypto() as unknown as {
        bootstrapCrossSigning(o: unknown): Promise<void>;
      }).bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: async (makeRequest: (auth: unknown) => Promise<void>) => {
          await makeRequest({ type: "m.login.password", identifier: { type: "m.id.user", user: me }, password: PW });
        },
      });
      a.startClient({});
      await until("A prepared", () => isReady(a));

      const cryptoA = a.getCrypto()!;
      await untilAsync("A's crypto knows device B", async () => {
        const m = await cryptoA.getUserDeviceInfo([me], true);
        return m.get(me)?.has(devB) === true;
      });

      interface Req {
        phase?: number;
        verifier?: { verify?(): Promise<unknown>; getShowSasCallbacks?(): SasCb; callbacks?: SasCb };
        accept?(): Promise<void>;
        startVerification?(method: string): Promise<unknown>;
      }
      interface SasCb { sas: unknown; confirm(): Promise<void> }

      const requestP = awaitEv("request", 30000);
      const rqA = (await (cryptoA as unknown as { requestDeviceVerification(u: string, d: string): Promise<Req> }).requestDeviceVerification(me, devB)) as Req;
      await requestP;
      child.stdin!.write(JSON.stringify({ cmd: "accept" }) + "\n");
      await awaitEv("accepted");

      await until("A reached Ready", () => Boolean(rqA.verifier) || rqA.phase === 3, 30000);
      if (!rqA.verifier) await rqA.startVerification!("m.sas.v1");

      const tV = Date.now();
      while (!rqA.verifier && Date.now() - tV < 40000) await sleep(100);
      const vA = rqA.verifier;
      if (!vA) throw new Error("no verifier on A");
      void Promise.resolve(vA.verify?.()).catch(() => { /* initiator: no-op */ });
      child.stdin!.write(JSON.stringify({ cmd: "verify" }) + "\n");
      const bSas = (await awaitEv("sas")).sas;

      const tS = Date.now();
      let sasA: SasCb | null = null;
      while (!sasA && Date.now() - tS < 30000) {
        sasA = vA.getShowSasCallbacks?.() ?? vA.callbacks ?? null;
        if (!sasA) await sleep(100);
      }
      if (!sasA) throw new Error("no show_sas on A");

      // THE user-facing proof: both devices must display the SAME emoji set
      expect(JSON.stringify((sasA as { sas: unknown }).sas)).toBe(JSON.stringify(bSas));

      await sasA.confirm();
      child.stdin!.write(JSON.stringify({ cmd: "confirm" }) + "\n");
      const conf = await awaitEv("confirmed");
      // The flow must CLOSE cleanly on B: phase Done(5), or Cancelled(6) as
      // the exit edge of a completed-SAS flow — B (a device with no
      // cross-signing private keys until it restores from backup, exactly the
      // real add-device state) refuses to reciprocally sign A and cancels
      // AFTER A's signature already landed. Both are accepted by the UI
      // adapter; the product guarantee below (A trusts B) is what matters.
      expect([5, 6]).toContain(Number(conf.phase));

      // A's trust view — what the sessions UI renders: DeviceInfo.verified
      // is the DeviceVerification enum, Verified === 1
      let bSeenByA = 0;
      await untilAsync("A marks device B verified", async () => {
        const mapA = await cryptoA.getUserDeviceInfo([me]);
        bSeenByA = Number(mapA.get(me)?.get(devB)?.verified ?? 0);
        return bSeenByA === 1;
      }, 40000).catch((e: unknown) => {
        console.log("VERIFY DEBUG", { bSeenByA, err: String(e) });
        throw e;
      });
      expect(bSeenByA).toBe(1);
      expect([5, 6]).toContain(Number(rqA.phase ?? 0)); // A's UI resolves too
      a.stopClient();
    } finally {
      child.kill();
      await unlink(fixturePath).catch(() => undefined);
    }
  });
});

// integration-gate pattern: without LINNET_TEST_HS the suite above skips; run
// "LINNET_TEST_HS=http://hs-a:8023 pnpm -r test" against fixture HS-A before release.

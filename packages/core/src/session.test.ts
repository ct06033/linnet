import { describe, expect, it } from "vitest";
import { createFakeHomeserver, makeSyncSnapshot } from "./fake-homeserver.js";
import { ACCOUNTS_KV_KEY, MemoryKv, MemorySecrets, secretKeyFor } from "./accounts.js";
import { SessionManager, type RoomSummary, type SyncStatus } from "./session.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = { userId: "@bob:hs.test", password: "pw-bob", accessToken: "tok-bob" };

function makeFetch(): typeof globalThis.fetch {
  return createFakeHomeserver({
    accounts: [ALICE, BOB],
    sync: (userId) =>
      userId === ALICE.userId
        ? makeSyncSnapshot({
            userId,
            rooms: [
              { roomId: "!a1:hs.test", name: "linnet-dev" },
              { roomId: "!dm1:hs.test", name: "Mel" },
            ],
            direct: ["!dm1:hs.test"],
            invites: [{ roomId: "!in1:hs.test", name: "design-help" }],
          })
        : makeSyncSnapshot({ userId, rooms: [{ roomId: "!b1:hs.test", name: "bob-room" }] }),
  });
}

function mkManager() {
  return new SessionManager({
    kv: new MemoryKv(),
    secrets: new MemorySecrets(),
    fetchFn: makeFetch(),
  });
}

async function until(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("until: condition not met");
}

const aliceId = `${ALICE.userId}|FAKEDEV`;
const bobId = `${BOB.userId}|FAKEDEV`;

describe("SessionManager", () => {
  it("logs in two accounts, keeps tokens out of KV, switches active", async () => {
    const kv = new MemoryKv();
    const secrets = new MemorySecrets();
    const sm = new SessionManager({ kv, secrets, fetchFn: makeFetch() });
    const a = await sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    const b = await sm.login({ homeserverUrl: "https://hs.test", username: BOB.userId, password: BOB.password });
    expect(a.accountId).toBe(aliceId);
    expect(b.accountId).toBe(bobId);
    expect(sm.activeId).toBe(bobId); // last login wins
    const stored = await kv.get(ACCOUNTS_KV_KEY);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("tok-alice");
    expect(await secrets.load(secretKeyFor(aliceId))).toBe(ALICE.accessToken);
    sm.stopAll();
  });

  it("bad password rejects, stores nothing", async () => {
    const secrets = new MemorySecrets();
    const sm = new SessionManager({ kv: new MemoryKv(), secrets, fetchFn: makeFetch() });
    await expect(
      sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: "wrong" }),
    ).rejects.toThrow();
    expect(await sm.listAccounts()).toHaveLength(0);
    expect(secrets.keys()).toHaveLength(0);
  });

  it("sync of active account emits room summaries (DM + invite flags)", async () => {
    const sm = mkManager();
    await sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    const got: Map<string, string> = new Map();
    sm.onRooms((id, rooms) => {
      if (id === aliceId) for (const r of rooms) got.set(r.name, `${r.isDM ? "dm" : "room"}${r.invite ? "+invite" : ""}`);
    });
    await until(() => got.has("linnet-dev"));
    expect(got.get("Mel")).toBe("dm");
    expect(got.get("design-help")).toBe("room+invite");
    sm.stopAll();
  });

  it("logout wipes secret, removes account, falls back active", async () => {
    const secrets = new MemorySecrets();
    const sm = new SessionManager({ kv: new MemoryKv(), secrets, fetchFn: makeFetch() });
    await sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    await sm.login({ homeserverUrl: "https://hs.test", username: BOB.userId, password: BOB.password });
    await sm.logout(bobId);
    expect(await secrets.load(secretKeyFor(bobId))).toBeNull();
    const accounts = await sm.listAccounts();
    expect(accounts.map((x) => x.accountId)).toEqual([aliceId]);
    expect(sm.activeId).toBe(aliceId);
    sm.stopAll();
  });

  it("restore() rebuilds live sessions from kv+secrets", async () => {
    const kv = new MemoryKv();
    const secrets = new MemorySecrets();
    const sm1 = new SessionManager({ kv, secrets, fetchFn: makeFetch() });
    await sm1.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    sm1.stopAll();
    const sm2 = new SessionManager({ kv, secrets, fetchFn: makeFetch() });
    const orphans = await sm2.restore();
    expect(orphans).toHaveLength(0);
    expect(sm2.activeId).toBe(aliceId);
    const names = new Set<string>();
    sm2.onRooms((id, rooms) => { for (const r of rooms) names.add(r.name); });
    sm2.startSync(aliceId);
    await until(() => names.has("linnet-dev"));
    sm2.stopAll();
  });
});

// W8 — legacy SSO (UIAA redirect): discover → bounce → one-time loginToken.
describe("SessionManager SSO (W8)", () => {
  const ssoFetch = createFakeHomeserver({
    accounts: [ALICE, BOB],
    sso: [{ id: "okta", name: "Okta", brand: "okta" }],
    sync: (userId) => makeSyncSnapshot({ userId, rooms: [{ roomId: "!r1:hs.test", name: "sso-room" }] }),
  });
  const mk = () => new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: ssoFetch });

  it("S1 discovers password+sso flows with identity providers", async () => {
    const f = await mk().discoverLogin("https://hs.test");
    expect(f.password).toBe(true);
    expect(f.sso).toBe(true);
    expect(f.identityProviders).toEqual([{ id: "okta", name: "Okta", brand: "okta" }]);
  });

  it("S2 getSsoLoginUrl follows the 302 and returns the IdP target with loginToken", async () => {
    const url = await mk().getSsoLoginUrl("https://hs.test", "https://app.test/");
    expect(url.startsWith("https://app.test/")).toBe(true);
    expect(new URL(url).searchParams.get("loginToken")).toMatch(/^ssotok-/);
  });

  it("S3 loginWithSsoToken lands a live session; token is one-time", async () => {
    const sm = mk();
    const bounced = await sm.getSsoLoginUrl("https://hs.test", "https://app.test/");
    const loginToken = new URL(bounced).searchParams.get("loginToken")!;
    const meta = await sm.loginWithSsoToken("https://hs.test", loginToken);
    expect(meta.accountId).toBe(aliceId); // fake IdP authenticates accounts[0]
    expect(sm.activeId).toBe(aliceId);
    await expect(sm.loginWithSsoToken("https://hs.test", loginToken)).rejects.toThrow(/invalid token|403/);
    sm.stopAll();
  });

  it("S4 discovery on a no-SSO homeserver hides SSO (password only)", async () => {
    const f = await mkManager().discoverLogin("https://hs.test");
    expect(f.sso).toBe(false);
    expect(f.identityProviders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W12a — first-sync lifecycle (regression suite for the "waiting for first
// sync…" hang): restore must auto-start sync, transient errors must SURFACE
// and auto-recover, M_UNKNOWN_TOKEN must surface as fatal without a retry storm.
// ---------------------------------------------------------------------------

function brokenSyncFetch(mode: "fail-first" | "always-401"): typeof globalThis.fetch {
  const base = createFakeHomeserver({
    accounts: [ALICE, BOB],
    sync: (userId) =>
      userId === ALICE.userId
        ? makeSyncSnapshot({
            userId,
            rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev" }],
          })
        : makeSyncSnapshot({ userId }),
  });
  let failedFirst = false;
  const wrapper = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isInitialSync = /\/sync(\?|$)/.test(url) && !new URL(url).searchParams.get("since");
    if (isInitialSync && (mode === "always-401" || !failedFirst)) {
      failedFirst = true;
      const body =
        mode === "always-401"
          ? { errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised token", soft_logout: false }
          : { errcode: "M_UNKNOWN", error: "injected first-sync failure" };
      return new Response(JSON.stringify(body), {
        status: mode === "always-401" ? 401 : 500,
        headers: { "content-type": "application/json" },
      });
    }
    return base(input, init);
  };
  return wrapper as unknown as typeof globalThis.fetch;
}

describe("W12a first-sync lifecycle", () => {
  it("restore() auto-starts the first sync (cold-boot hang regression)", { timeout: 30000 }, async () => {
    const kv = new MemoryKv();
    const secrets = new MemorySecrets();
    const sm1 = new SessionManager({ kv, secrets, fetchFn: makeFetch() });
    await sm1.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    sm1.stopAll();
    const sm2 = new SessionManager({ kv, secrets, fetchFn: makeFetch() });
    const names = new Set<string>();
    const phases: SyncStatus["phase"][] = [];
    sm2.onRooms((_id, rooms) => {
      for (const r of rooms) names.add(r.name);
    });
    sm2.onSyncStatus((_id, st) => phases.push(st.phase));
    await sm2.restore(); // used to build clients WITHOUT ever starting sync
    await until(() => names.has("linnet-dev"), 1000); // 10s budget
    expect(phases).toContain("prepared");
    sm2.stopAll();
  });

  it("transient first-sync error surfaces as status, then sync recovers and populates rooms", { timeout: 45000 }, async () => {
    const sm = new SessionManager({
      kv: new MemoryKv(),
      secrets: new MemorySecrets(),
      fetchFn: brokenSyncFetch("fail-first"),
    });
    const statuses: SyncStatus[] = [];
    let rooms: RoomSummary[] = [];
    sm.onSyncStatus((_id, st) => statuses.push(st));
    sm.onRooms((_id, r) => {
      rooms = r;
    });
    await sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    await until(() => statuses.some((s) => s.phase === "error" && !s.fatal), 800); // error VISIBLE, not swallowed
    await until(() => rooms.length > 0, 1500); // auto-restart (1s backoff) lands the room list
    expect(rooms.map((r) => r.name)).toContain("linnet-dev");
    expect(statuses[statuses.length - 1]?.phase).toBe("prepared");
    sm.stopAll();
  });

  it("M_UNKNOWN_TOKEN on first sync surfaces FATAL error — no infinite retry storm", { timeout: 30000 }, async () => {
    const sm = new SessionManager({
      kv: new MemoryKv(),
      secrets: new MemorySecrets(),
      fetchFn: brokenSyncFetch("always-401"),
    });
    const statuses: SyncStatus[] = [];
    sm.onSyncStatus((_id, st) => statuses.push(st));
    await sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    await until(() => statuses.some((s) => s.phase === "error" && s.fatal), 1000);
    const atFatal = statuses.length;
    await new Promise((r) => setTimeout(r, 2500)); // backoff windows would fire here
    // after the fatal status nothing further may flip to non-fatal error states
    expect(statuses.slice(atFatal).every((s) => s.phase !== "error" || s.fatal)).toBe(true);
    sm.stopAll();
  });
});

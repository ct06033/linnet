import { describe, expect, it } from "vitest";
import { createFakeHomeserver, makeSyncSnapshot } from "./fake-homeserver.js";
import { ACCOUNTS_KV_KEY, MemoryKv, MemorySecrets, secretKeyFor } from "./accounts.js";
import { SessionManager } from "./session.js";

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

/**
 * W5b T2 — space actions against the fake homeserver with a REAL js-sdk
 * client (no UI): asserts the exact wire calls the actions must make.
 */
import { describe, expect, it } from "vitest";
import { createFakeHomeserver, createClientSession } from "@linnet/core";
import { addRoomToSpace, createRoom, createSpace, leaveAndMaybeForget, removeRoomFromSpace } from "./actions.js";

const ALICE = { userId: "@alice:hs.test", password: "pw", accessToken: "tok" };

function harness() {
  const fetchFn = createFakeHomeserver({ accounts: [ALICE] });
  const client = createClientSession({
    homeserverUrl: "https://hs.test",
    accessToken: ALICE.accessToken,
    deviceId: "DEV1",
    userId: ALICE.userId,
    fetchFn,
  });
  return { client, calls: fetchFn.controls.calls };
}

describe("createSpace (T2a/T2b)", () => {
  it("POSTs creation_content.type m.space with private preset by default", async () => {
    const { client, calls } = harness();
    const id = await createSpace(client, { name: "Work", isPublic: false });
    expect(id).toContain("hs.test");
    const post = calls.find((c) => c.path.endsWith("/createRoom"));
    expect(post?.method).toBe("POST");
    const body = post?.body as Record<string, unknown>;
    expect(body["creation_content"]).toEqual({ type: "m.space" });
    expect(body["name"]).toBe("Work");
    expect(body["visibility"]).toBe("private");
    expect(body["preset"]).toBe("private_chat");
  });

  it("public spaces map to public visibility + public_chat (T2b)", async () => {
    const { client, calls } = harness();
    await createSpace(client, { name: "Club", isPublic: true });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["visibility"]).toBe("public");
    expect(body["preset"]).toBe("public_chat");
  });

  // W12a E2EE-default: new rooms start encrypted; 'off' must be an explicit opt-out.
  it("private spaces default to initial_state m.room.encryption (W12a)", async () => {
    const { client, calls } = harness();
    await createSpace(client, { name: "Secured", isPublic: false });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["initial_state"]).toEqual([
      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    ]);
  });

  it("encrypt:false opts out explicitly (W12a)", async () => {
    const { client, calls } = harness();
    await createSpace(client, { name: "Plain", isPublic: false, encrypt: false });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["initial_state"]).toBeUndefined();
  });

  it("public spaces never ship the encryption event (forced opt-out)", async () => {
    const { client, calls } = harness();
    await createSpace(client, { name: "Pub", isPublic: true, encrypt: true });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["initial_state"]).toBeUndefined();
  });
});

// W12 merged flow: the unified rail "+" creates plain rooms through the same
// E2EE-default rule as spaces (w12-core intent carried into w12-ui dialogs).
describe("createRoom (W12 item 7 parity)", () => {
  it("private rooms default to initial_state m.room.encryption", async () => {
    const { client, calls } = harness();
    await createRoom(client, { name: "Lobby", isPublic: false });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["creation_content"]).toBeUndefined();
    expect(body["initial_state"]).toEqual([
      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    ]);
  });

  it("encrypt:false opts out explicitly", async () => {
    const { client, calls } = harness();
    await createRoom(client, { name: "Open", isPublic: false, encrypt: false });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["initial_state"]).toBeUndefined();
  });

  it("public rooms never ship the encryption event (forced opt-out)", async () => {
    const { client, calls } = harness();
    await createRoom(client, { name: "Pub", isPublic: true, encrypt: true });
    const body = calls.find((c) => c.path.endsWith("/createRoom"))?.body as Record<string, unknown>;
    expect(body["initial_state"]).toBeUndefined();
  });
});

describe("m.space.child sends (T2c/T2d)", () => {
  it("PUT /state/m.space.child/{roomId} with via = own homeserver domain", async () => {
    const { client, calls } = harness();
    await addRoomToSpace(client, "!sp:hs.test", "!team:hs.test");
    const put = calls.find((c) => c.method === "PUT" && /\/state\/m\.space\.child\//.test(c.path));
    expect(put).toBeTruthy();
    expect(decodeURIComponent(put!.path)).toContain("/state/m.space.child/!team:hs.test");
    expect(put!.body).toEqual({ via: ["hs.test"] });
  });

  it("order is included when provided", async () => {
    const { client, calls } = harness();
    await addRoomToSpace(client, "!sp:hs.test", "!team:hs.test", "a.1");
    const put = calls.find((c) => c.method === "PUT" && /state\/m\.space\.child/.test(c.path));
    expect(put!.body).toEqual({ via: ["hs.test"], order: "a.1" });
  });

  it("removal sends EMPTY content (missing via => reprised child, spec §11.1)", async () => {
    const { client, calls } = harness();
    await removeRoomFromSpace(client, "!sp:hs.test", "!team:hs.test");
    const put = calls.find((c) => c.method === "PUT" && /state\/m\.space\.child/.test(c.path));
    expect(put!.body).toEqual({});
  });
});

describe("leave/forget (T2e)", () => {
  it("without forget: POST /leave only", async () => {
    const { client, calls } = harness();
    await leaveAndMaybeForget(client, "!r:hs.test", false);
    expect(calls.some((c) => c.path.endsWith("/rooms/%21r%3Ahs.test/leave") || decodeURIComponent(c.path).endsWith("/leave"))).toBe(true);
    expect(calls.some((c) => decodeURIComponent(c.path).endsWith("/forget"))).toBe(false);
  });

  it("with forget: /forget AFTER /leave", async () => {
    const { client, calls } = harness();
    await leaveAndMaybeForget(client, "!r:hs.test", true);
    const dec = calls.map((c) => decodeURIComponent(c.path));
    const li = dec.findIndex((p) => p.endsWith("/leave"));
    const fo = dec.findIndex((p) => p.endsWith("/forget"));
    expect(li).toBeGreaterThanOrEqual(0);
    expect(fo).toBeGreaterThan(li);
  });
});

/**
 * P1 presence: dots render from /sync presence events (chat heads, member
 * list, DM sub-header), unknown state hides the dot, and the account menu
 * picker persists + PUTs /presence/{}/status via SessionManager.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
  type FakeHomeserverControls,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";
const CAROL = "@carol:hs.test";

const MSG: FakeEventLike = {
  type: "m.room.message",
  sender: BOB,
  content: { msgtype: "m.text", body: "hello there" },
  event_id: "$p1",
  origin_server_ts: 1000,
};

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function mk(kv = new MemoryKv()) {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!dev:hs.test",
            name: "linnet-dev",
            members: { [BOB]: "join", [CAROL]: "join", "@alice:hs.test": "join" },
            events: [MSG],
          },
        ],
        presence: [
          { userId: BOB, presence: "online", statusMsg: "at the wheel", currentlyActive: true },
          { userId: CAROL, presence: "offline", lastActiveAgo: 7_200_000 },
        ],
      }),
  });
  vi.stubGlobal("fetch", fake);
  return { kv, sm: new SessionManager({ kv, secrets: new MemorySecrets(), fetchFn: fake }) };
}

async function signInAndOpenDev(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("linnet-dev");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
  await screen.findByText("hello there");
}

describe("P1 presence", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    const { sm } = mk();
    setSessionManagerForTests(sm);
  });
  afterEach(() => setSessionManagerForTests(mk().sm));

  it("online member shows a dot on the chat head; label carries status_msg", async () => {
    await signInAndOpenDev();
    const dots = await screen.findAllByTestId("presence-online");
    const bobDot = dots.find((d) => d.getAttribute("data-user") === BOB);
    expect(bobDot).toBeTruthy();
    expect(bobDot!.getAttribute("title")).toContain("at the wheel");
  });

  it("room settings member list carries the dots", async () => {
    await signInAndOpenDev();
    fireEvent.click(screen.getByLabelText("Room settings"));
    await screen.findByText(/Joined \(3\)/);
    const list = screen.getByLabelText("Members");
    const bobOnline = [...list.querySelectorAll(".p-online")].some((d) => d.getAttribute("data-user") === BOB);
    expect(bobOnline).toBe(true);
    const carol = [...list.querySelectorAll(".p-offline")].find((d) => d.getAttribute("data-user") === CAROL);
    expect(carol).toBeTruthy();
    expect(carol!.getAttribute("title")).toMatch(/Last seen 2 h ago/);
  });

  it("users with no presence events show only neutral offline dots — never a false green/idle", async () => {
    fake = createFakeHomeserver({
      accounts: [ALICE],
      sync: (uid) =>
        makeSyncSnapshot({
          userId: uid,
          rooms: [
            {
              roomId: "!dev:hs.test",
              name: "linnet-dev",
              members: { "@dave:hs.test": "join", [ALICE.userId]: "join" },
              events: [{ ...MSG, sender: "@dave:hs.test" }],
            },
          ],
          // presence list deliberately empty
        }),
    });
    vi.stubGlobal("fetch", fake);
    setSessionManagerForTests(new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake }));
    render(<App />);
    await screen.findByText("Sign in to Linnet");
    fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
    fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    const matches = await screen.findAllByText("linnet-dev");
    fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
    await screen.findByText("hello there");
    expect(document.querySelector(".p-online")).toBeNull();
    expect(document.querySelector(".p-unavailable")).toBeNull();
    expect(document.querySelector(".p-unknown")).toBeNull();
  });

  it("account menu picker: change persists per account and PUTs presence", async () => {
    const { sm } = mk();
    await sm.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    await sm.setPresenceFor(sm.activeId!, { presence: "unavailable", statusMsg: "busy" });
    expect(await sm.presenceFor(sm.activeId!)).toEqual({ presence: "unavailable", statusMsg: "busy" });
    await waitFor(() =>
      expect(
        fake.controls.calls.some(
            (c) => c.method === "PUT" && /\/presence\/.+\/status$/.test(c.path) && JSON.stringify(c.body ?? {}).includes("unavailable"),
          ),
      ).toBe(true),
    );
    // persistence across managers is covered by "session boot pushes the
    // stored presence once synced" (shared MemoryKv)
    sm.stopAll();
  });

  it("account menu exposes the picker and a change reaches the server", async () => {
    await signInAndOpenDev();
    fireEvent.click(screen.getByLabelText("Account menu"));
    const sel = await screen.findByLabelText("My presence");
    fireEvent.change(sel, { target: { value: "unavailable" } });
    await waitFor(
      () =>
        expect(
          fake.controls.calls.some(
            (c) => c.method === "PUT" && /\/presence\/.+\/status$/.test(c.path) && JSON.stringify(c.body ?? {}).includes("unavailable"),
          ),
        ).toBe(true),
      { timeout: 8000 },
    );
  });

  it("session boot pushes the stored presence once synced", async () => {
    const { kv } = mk();
    const seed = new SessionManager({ kv, secrets: new MemorySecrets(), fetchFn: fake });
    await seed.login({ homeserverUrl: "https://hs.test", username: ALICE.userId, password: ALICE.password });
    await seed.setPresenceFor(seed.activeId!, { presence: "offline" });
    seed.stopAll();

    fake.controls.calls.length = 0;
    const sm = new SessionManager({ kv, secrets: new MemorySecrets(), fetchFn: fake });
    await sm.restore(); // syncs; Prepared must trigger the stored presence
    await waitFor(
      () =>
        expect(
          fake.controls.calls.some(
            (c) => c.method === "PUT" && /\/presence\/.+\/status$/.test(c.path) && JSON.stringify(c.body ?? {}).includes("offline"),
          ),
        ).toBe(true),
      { timeout: 8000 },
    );
    sm.stopAll();
  });
});

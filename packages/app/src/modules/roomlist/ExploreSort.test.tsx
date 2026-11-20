/**
 * P1 sorting modes + explore/join public rooms.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
  type RoomSummary,
  type FakeHomeserverControls,
} from "@linnet/core";
import { loadSortMode, saveSortMode, sortRooms } from "./sorts.js";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

function sum(name: string, lastTs: number, unread = 0): RoomSummary {
  return {
    roomId: `!${name}:hs.test`,
    name,
    isDM: false,
    unread,
    invite: false,
    isSpace: false,
    membership: "join",
    e2ee: false,
    spaceChildren: [],
    memberCount: 2,
    favourite: false,
    lastTs,
  };
}

describe("sortRooms", () => {
  it("orders by recent / A-Z / unread-first", () => {
    const rooms = [sum("beta", 200), sum("alpha", 300), sum("gamma", 100, 5)];
    expect(sortRooms(rooms, "recent").map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(sortRooms(rooms, "az").map((r) => r.name)).toEqual(["alpha", "beta", "gamma"].sort());
    expect(sortRooms(rooms, "unread").map((r) => r.name)).toEqual(["gamma", "alpha", "beta"]);
  });
  it("pref survives roundtrip, unknown values fall back to recent", () => {
    saveSortMode("az");
    expect(loadSortMode()).toBe("az");
    globalThis.localStorage?.setItem("linnet.roomsort.v1", "chaos");
    expect(loadSortMode()).toBe("recent");
    saveSortMode("recent");
  });
});

// ---- app level ----
const MSG = (id: string, body: string, ts: number): FakeEventLike => ({
  type: "m.room.message",
  sender: "@bob:hs.test",
  content: { msgtype: "m.text", body },
  event_id: id,
  origin_server_ts: ts,
});

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function mk(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          { roomId: "!zoo:hs.test", name: "Alpha Room", members: { [ALICE.userId]: "join" }, events: [MSG("$z", "a old", 1000)] },
          { roomId: "!bee:hs.test", name: "Bear Room", members: { [ALICE.userId]: "join" }, events: [MSG("$b", "b new", 9000)] },
        ],
      }),
    publicRooms: [{ roomId: "!pub:hs.test", name: "The Lounge", topic: "open chatter", members: 42 }],
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function signIn(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await screen.findByText("Alpha Room");
}

describe("P1 sorts + explore in the room list", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    saveSortMode("recent");
    setSessionManagerForTests(mk());
  });
  afterEach(() => setSessionManagerForTests(mk()));

  it("default recent order puts the newer-activity room first; A-Z flips it", async () => {
    await signIn();
    const list = screen.getByLabelText("Rooms");
    expect(within(list).getAllByText(/[A-Za-z]+ Room$/).map((e) => e.textContent)).toEqual(["Bear Room", "Alpha Room"]);
    fireEvent.change(screen.getByTestId("sort-mode"), { target: { value: "az" } });
    await waitFor(() =>
      expect(within(list).getAllByText(/[A-Za-z]+ Room$/).map((e) => e.textContent)).toEqual(["Alpha Room", "Bear Room"]),
    );
    expect(loadSortMode()).toBe("az");
    saveSortMode("recent");
  });

  it("explore lists directory rooms and join reaches the server", async () => {
    await signIn();
    fireEvent.click(screen.getByTestId("explore-open"));
    await screen.findByTestId("explore-panel");
    const row = await screen.findByTestId("explore-!pub:hs.test");
    expect(row.textContent).toContain("The Lounge");
    expect(row.textContent).toContain("42 members");
    fireEvent.click(within(row).getByLabelText("Join The Lounge"));
    await waitFor(() =>
      expect(fake.controls.calls.some((c) => c.method === "POST" && /\/join\//.test(c.path))).toBe(true),
    );
    await waitFor(() => expect(row.textContent).toContain("joined"));
    fireEvent.click(screen.getByLabelText("Close explore"));
    await waitFor(() => expect(screen.queryByTestId("explore-panel")).toBeNull());
  });
});

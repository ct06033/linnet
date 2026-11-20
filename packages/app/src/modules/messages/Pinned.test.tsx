/**
 * P1 message pinning: standard m.room.pinned_events state, header chip,
 * right-hand pinned list (timeline-resolved + fetched-missing + unavailable),
 * pin/unpin from row chrome and from the panel, newest-first order.
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
  type FakeRoom,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

const MESSAGES: FakeEventLike[] = [
  {
    type: "m.room.message",
    sender: BOB,
    content: { msgtype: "m.text", body: "pin me first" },
    event_id: "$m1",
    origin_server_ts: 1000,
  },
  {
    type: "m.room.message",
    sender: ALICE.userId,
    content: { msgtype: "m.text", body: "and me second" },
    event_id: "$m2",
    origin_server_ts: 2000,
  },
];

let fake: typeof globalThis.fetch & { controls: unknown };

function freshManager(seedPinned?: string[]): SessionManager {
  const room: FakeRoom = {
    roomId: "!dev:hs.test",
    name: "linnet-dev",
    members: { [BOB]: "join", [ALICE.userId]: "join" },
    events: MESSAGES,
    ...(seedPinned ? { pinned: seedPinned } : {}),
  };
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) => makeSyncSnapshot({ userId: uid, rooms: [room] }),
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
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
}

function rowOf(evid: string): Element {
  const el = document.querySelector(`[data-evid="${evid}"]`);
  expect(el).toBeTruthy();
  return el!;
}

describe("P1 pinning", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("pin from the row: chip appears, row marked, state echoes through sync", async () => {
    await signInAndOpenDev();
    await screen.findByText("pin me first");
    fireEvent.click(within_row("$m1"));
    const chip = await screen.findByTestId("pinned-chip");
    expect(chip.textContent).toContain("1");
    expect(rowOf("$m1").classList.contains("pinned")).toBe(true);
    // button flips to Unpin semantics
    expect(
      rowOf("$m1").querySelector('[aria-label="Unpin message"]'),
    ).toBeTruthy();
  });

  it("unpin removes the chip", async () => {
    await signInAndOpenDev();
    await screen.findByText("pin me first");
    fireEvent.click(within_row("$m1"));
    await screen.findByTestId("pinned-chip");
    fireEvent.click(rowOf("$m1").querySelector('[aria-label="Unpin message"]')!);
    await waitFor(() => expect(screen.queryByTestId("pinned-chip")).toBeNull());
  });

  it("newest-first: pinning $m2 after $m1 lists $m2 on top", async () => {
    await signInAndOpenDev();
    await screen.findByText("pin me first");
    fireEvent.click(within_row("$m1"));
    await screen.findByTestId("pinned-chip");
    fireEvent.click(within_row("$m2"));
    await waitFor(() => expect(screen.getByTestId("pinned-chip").textContent).toContain("2"));
    fireEvent.click(screen.getByTestId("pinned-chip"));
    const panel = await screen.findByTestId("pinned-panel");
    const rows = [...panel.querySelectorAll(".pinned-row")];
    expect(rows[0]?.textContent).toContain("and me second");
    expect(rows[1]?.textContent).toContain("pin me first");
  });

  it("panel lists seeded pins; unpin from the panel drops the row", async () => {
    setSessionManagerForTests(freshManager(["$m1"]));
    await signInAndOpenDev();
    await screen.findByText("pin me first");
    fireEvent.click(await screen.findByTestId("pinned-chip"));
    const row = await screen.findByTestId("pinned-row-$m1");
    expect(row.textContent).toContain("pin me first");
    fireEvent.click(row.querySelector('[aria-label="Unpin message"]')!);
    await waitFor(() => expect(screen.queryByTestId("pinned-chip")).toBeNull());
  });

  it("pinned id outside the timeline degrades to 'unavailable' (fetch 404)", async () => {
    setSessionManagerForTests(freshManager(["$gone"]));
    await signInAndOpenDev();
    await screen.findByText("pin me first");
    fireEvent.click(await screen.findByTestId("pinned-chip"));
    await screen.findByTestId("pinned-row-$gone");
    expect(await screen.findByText(/Message unavailable/i)).toBeTruthy();
  });

  it("jump button is disabled for pins the timeline does not hold", async () => {
    setSessionManagerForTests(freshManager(["$gone"]));
    await signInAndOpenDev();
    await screen.findByText("pin me first");
    fireEvent.click(await screen.findByTestId("pinned-chip"));
    const row = await screen.findByTestId("pinned-row-$gone");
    expect((row.querySelector('[aria-label="Jump to message"]') as HTMLButtonElement).disabled).toBe(true);
  });
});

function within_row(evid: string): Element {
  const btn = rowOf(evid).querySelector('[aria-label="Pin message"]');
  expect(btn).toBeTruthy();
  return btn!;
}

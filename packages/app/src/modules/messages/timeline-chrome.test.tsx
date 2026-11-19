/**
 * W12 timeline chrome: item 10 (own messages visibly distinct via .mine +
 * accent-derived bubble) and item 13 ("Load earlier messages" as a plain
 * text button — no box). Driven through the real js-sdk + fake homeserver.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
  type FakeHomeserverControls,
  type FakeRoom,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

const DEV_OLD: FakeEventLike[] = [
  {
    type: "m.room.message",
    sender: BOB,
    content: { msgtype: "m.text", body: "OLDER" },
    event_id: "$old1",
    origin_server_ts: 10,
  },
];

function seeded(): FakeEventLike[] {
  return [
    {
      type: "m.room.message",
      sender: BOB,
      content: { msgtype: "m.text", body: "from-bob" },
      event_id: "$b1",
      origin_server_ts: 1000,
    },
    {
      type: "m.room.message",
      sender: ALICE.userId,
      content: { msgtype: "m.text", body: "from-alice" },
      event_id: "$a1",
      origin_server_ts: 2000,
    },
  ];
}

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function freshManager(): SessionManager {
  const room: FakeRoom = {
    roomId: "!dev:hs.test",
    name: "linnet-dev",
    members: { [BOB]: "join", [ALICE.userId]: "join" },
    events: seeded(),
    old: DEV_OLD,
  };
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) => makeSyncSnapshot({ userId: uid, rooms: [room] }),
    roomsLookup: () => [{ roomId: "!dev:hs.test", old: DEV_OLD }],
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function signInAndOpen(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  fireEvent.click(await screen.findByText("linnet-dev", { selector: ".roomlist .name" }));
  await screen.findByTestId("roomview");
  await screen.findByText("from-bob");
}

describe("W12 item 10 — own message treatment", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  function rowFor(testid: string): Element | undefined {
    return Array.from(document.querySelectorAll(".roomview .row")).find(
      (r) => r.querySelector(`[data-testid="${testid}"]`) !== null,
    );
  }

  it("own rows carry .mine + data-mine=true, others data-mine=false", async () => {
    await signInAndOpen();
    const mine = rowFor("msg-$a1")!;
    const other = rowFor("msg-$b1")!;
    expect(mine.className).toContain("mine");
    expect(mine.getAttribute("data-mine")).toBe("true");
    expect(other.className).not.toContain("mine");
    expect(other.getAttribute("data-mine")).toBe("false");
    // the distinct styling is accent-derived and defined for the bubble
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/--own-bubble: color-mix\(in srgb, var\(--accent\)/);
    expect(css).toMatch(/\.roomview \.row\.mine \.content \{[^}]*var\(--own-bubble\)/);
  });

  it("reactions/replies chrome still render inside own bubbles", async () => {
    await signInAndOpen();
    const mine = rowFor("msg-$a1")!;
    // own message keeps the full action chrome (reply/delete present, edit for text)
    expect(mine.querySelector('[aria-label="Reply"]')).toBeTruthy();
    expect(mine.querySelector('[aria-label="Edit"]')).toBeTruthy();
    expect(mine.querySelector('[aria-label="Delete"]')).toBeTruthy();
    expect(mine.querySelector(".reactions")).toBeTruthy();
  });

  it("newly sent own messages are marked mine live", async () => {
    await signInAndOpen();
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "mine now" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const el = await screen.findByText("mine now");
    const row = el.closest(".row")!;
    await waitFor(() => expect(row.className).toContain("mine"));
  });
});

describe("W12 item 13 — Load earlier messages is a plain text button", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("the control carries .load-earlier, CSS drops the box/border, pagination works", async () => {
    await signInAndOpen();
    const btn = await screen.findByText("Load earlier messages");
    expect(btn.closest("button")!.className).toContain("load-earlier");
    fireEvent.click(btn);
    expect(await screen.findByText("OLDER")).toBeTruthy();
    // styling contract: no border, transparent background = text-link feel
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.load-earlier \{[^}]*border: 0/);
    expect(css).toMatch(/\.load-earlier \{[^}]*background: transparent/);
  });
});

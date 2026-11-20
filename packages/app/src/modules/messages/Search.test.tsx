/**
 * P1 search + jump-to-date: local-timeline scan with pagination-to-date
 * (measured: Synapse 1.165 serves neither MSC3030 /timestamps nor /search,
 * so the client-side path IS the feature).
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

// yesterday 00:01 local — matches the panel's date-target math
const yStart = new Date();
yStart.setDate(yStart.getDate() - 1);
yStart.setHours(0, 0, 0, 0);
const OLD_TS = yStart.getTime() + 60_000;
const YESTERDAY_ISO = `${yStart.getFullYear()}-${String(yStart.getMonth() + 1).padStart(2, "0")}-${String(yStart.getDate()).padStart(2, "0")}`;

const LIVE: FakeEventLike[] = [
  { type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "today the QUICK brown fox" }, event_id: "$l1", origin_server_ts: Date.now() },
];
const OLD: FakeEventLike[] = [
  { type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "quick note from yesterday" }, event_id: "$o1", origin_server_ts: OLD_TS },
];

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function mk(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [{ roomId: "!dev:hs.test", name: "linnet-dev", members: { [BOB]: "join", [ALICE.userId]: "join" }, events: LIVE, old: OLD }],
      }),
    roomsLookup: () => [{ roomId: "!dev:hs.test", old: OLD }],
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function signInOpenSearch(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const rows = await screen.findAllByText("linnet-dev");
  fireEvent.click(rows.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
  await screen.findByText(/QUICK brown fox/);
  fireEvent.click(screen.getByTestId("search-open"));
  await screen.findByTestId("search-panel");
}

describe("P1 search + jump-to-date", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(mk());
  });
  afterEach(() => setSessionManagerForTests(mk()));

  it("typing a term finds loaded messages and highlights the match", async () => {
    await signInOpenSearch();
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "brown fox" } });
    const hit = await screen.findByTestId("hit-$l1");
    expect(hit.querySelector("mark")?.textContent).toBe("brown fox");
    fireEvent.click(hit);
    await waitFor(() => expect(screen.queryByTestId("search-panel")).toBeNull());
  });

  it("no-match message for loaded scope", async () => {
    await signInOpenSearch();
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "zzz nothing" } });
    await screen.findByText(/Nothing in the loaded timeline/);
  });

  it("jump-to-date pages history backward and lists the reached day", async () => {
    await signInOpenSearch();
    fireEvent.change(screen.getByTestId("date-input"), { target: { value: YESTERDAY_ISO } });
    fireEvent.click(screen.getByTestId("date-go"));
    const results = await screen.findByTestId("date-results");
    expect(results).toBeTruthy();
    // yesterday's message only exists because paginateToDate pulled it
    const rows = [...results.querySelectorAll(".search-hit")];
    expect(rows[0]?.getAttribute("data-testid")).toBe("hit-$o1");
    // and after landing, the term search now ALSO finds the paged-in message
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "yesterday" } });
    const sr = await screen.findByTestId("search-results");
    expect(sr.querySelector('[data-testid="hit-$o1"]')).toBeTruthy();
  });

  it("Esc closes the panel", async () => {
    await signInOpenSearch();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("search-panel")).toBeNull());
  });
});

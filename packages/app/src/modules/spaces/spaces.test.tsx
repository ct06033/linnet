/**
 * W5b — spaces at the app level: real rail, per-space room lists, create
 * space landing through the live sync push, add/remove child wire calls.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeHomeserverControls,
  type FakeRoom,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

const ROOMS: FakeRoom[] = [
  {
    roomId: "!sp1:hs.test",
    name: "Work",
    space: true,
    children: { "!team:hs.test": {}, "!sp2:hs.test": {}, "!dm:hs.test": {}, "!ghost:hs.test": {} },
  },
  { roomId: "!sp2:hs.test", name: "Nested", space: true, children: { "!deep:hs.test": {} } },
  { roomId: "!team:hs.test", name: "team" },
  { roomId: "!deep:hs.test", name: "deep" },
  { roomId: "!free:hs.test", name: "free" },
  { roomId: "!dm:hs.test", name: "Mel" },
];

let controls!: FakeHomeserverControls;

function freshManager(): SessionManager {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () => makeSyncSnapshot({ userId: ALICE.userId, rooms: ROOMS, direct: ["!dm:hs.test"] }),
  });
  controls = fetchFn.controls;
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn });
}

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

async function waitForRooms(): Promise<void> {
  await signIn();
  await screen.findByText("team", { selector: ".roomlist .name" });
}

describe("W5b spaces", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("S1: rail shows Home + name-sorted spaces after login", async () => {
    render(<App />);
    await waitForRooms();
    expect(screen.getByRole("button", { name: "Home" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Space Nested" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Space Work" })).toBeTruthy();
    // rail order is alphabetical (Nested < Work), Home first, + last
    const names = Array.from(document.querySelectorAll("nav.rail button.space")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Home", "Space Nested", "Space Work", "New space"]);
  });

  it("S8: spaces never render as room rows in Home", async () => {
    render(<App />);
    await waitForRooms();
    const list = document.querySelector(".roomlist");
    expect(list?.textContent).toContain("team");
    expect(list?.textContent).toContain("free");
    expect(list?.textContent).not.toMatch(/Work/);
  });

  it("S2/S7: selecting a space filters to its children (DMs excluded, nested folded)", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "Space Work" }));
    await waitFor(() => expect(screen.getByText("team", { selector: ".roomlist .name" })).toBeTruthy());
    const list = document.querySelector(".roomlist");
    expect(list?.textContent).toContain("team");
    expect(list?.textContent).toContain("deep"); // folded under Nested header
    expect(list?.textContent).not.toContain("free");
    expect(list?.textContent).not.toContain("Mel"); // S7 DMs never in spaces
    expect(list?.textContent).not.toContain("ghost");
  });

  it("S4: add-existing-room sends m.space.child PUT for a joined room", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "Space Work" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add room to space" }));
    const dialog = await screen.findByRole("dialog", { name: "Add existing room" });
    expect(dialog.textContent).toContain("free");
    fireEvent.click(screen.getByRole("button", { name: "free" }));
    await waitFor(() =>
      expect(
        controls.calls.find(
          (c) => c.method === "PUT" && decodeURIComponent(c.path).includes("/state/m.space.child/!free:hs.test"),
        ),
      ).toBeTruthy(),
    );
  });

  it("S5: remove-from-space (via row context menu) sends an empty-content child PUT", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "Space Work" }));
    // W12 item 8: the inline ✕ is gone — removal goes through the context menu
    expect(document.querySelector(".row-x")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Menu for team" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from space" }));
    await waitFor(() =>
      expect(
        controls.calls.find(
          (c) =>
            c.method === "PUT" &&
            decodeURIComponent(c.path).includes("/state/m.space.child/!team:hs.test") &&
            JSON.stringify(c.body) === "{}",
        ),
      ).toBeTruthy(),
    );
  });

  it("S3: New space dialog creates an m.space that lands live from sync", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "New space" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a new space" });
    fireEvent.change(dialog.querySelector("input[aria-label='Space name']") as HTMLInputElement, {
      target: { value: "Fun" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    // wire call: creation_content.type is the space marker
    await waitFor(() =>
      expect(
        controls.calls.find(
          (c) =>
            c.method === "POST" &&
            c.path.endsWith("/createRoom") &&
            JSON.stringify((c.body as Record<string, unknown>)?.["creation_content"]) === '{"type":"m.space"}',
        ),
      ).toBeTruthy(),
    );
    // and it appears in the rail via the sync push (real flow, not optimistic UI)
    await screen.findByRole("button", { name: "Space Fun" });
  });
});

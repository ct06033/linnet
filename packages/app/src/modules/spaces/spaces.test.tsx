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
    // rail order is alphabetical (Nested < Work), Home first; the old "+"
    // button is gone — W12 item 12 unified it into the bottom Add control
    const names = Array.from(document.querySelectorAll("nav.rail button.space")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Home", "Space Nested", "Space Work"]);
    expect(document.querySelector("nav.rail .space.add")).toBeNull();
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
    // W14 item 2: "+ Room" now lives at the BOTTOM of the list, not the header
    const add = await screen.findByRole("button", { name: "+ Room" });
    const bottom = document.querySelector(".roomlist-bottom")!;
    expect(bottom.contains(add)).toBe(true);
    const scroll = document.querySelector(".roomlist-scroll")!;
    expect(bottom.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(add);
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
    // W12 item 12: unified bottom Add control → New space (dialog unchanged)
    fireEvent.click(screen.getByRole("button", { name: "Add space or room" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New space" }));
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


  // W12a E2EE-default UI: the Encrypt toggle ships ON; opting out (and going
  // public, which forces it off) are the user's actions.
  it("W12a: create dialog defaults Encrypt ON and sends m.room.encryption", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "Add space or room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New space" }));
    const encBox = (await screen.findByRole("checkbox", { name: "Encrypt space (E2EE)" })) as HTMLInputElement;
    expect(encBox.checked).toBe(true);
    const dialog = screen.getByRole("dialog", { name: "Create a new space" });
    fireEvent.change(dialog.querySelector("input[aria-label='Space name']") as HTMLInputElement, {
      target: { value: "Crypt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() =>
      expect(
        controls.calls.find(
          (c) =>
            c.method === "POST" &&
            c.path.endsWith("/createRoom") &&
            JSON.stringify((c.body as Record<string, unknown>)?.["initial_state"]) ===
              '[{"type":"m.room.encryption","state_key":"","content":{"algorithm":"m.megolm.v1.aes-sha2"}}]',
        ),
      ).toBeTruthy(),
    );
  });

  it("W12a: unchecking Encrypt opts out (no initial_state on the wire)", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "Add space or room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New space" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Encrypt space (E2EE)" }));
    const dialog = screen.getByRole("dialog", { name: "Create a new space" });
    fireEvent.change(dialog.querySelector("input[aria-label='Space name']") as HTMLInputElement, {
      target: { value: "Plain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() =>
      expect(
        controls.calls.find((c) => c.method === "POST" && c.path.endsWith("/createRoom")),
      ).toBeTruthy(),
    );
    const body = controls.calls
      .filter((c) => c.method === "POST" && c.path.endsWith("/createRoom"))
      .map((c) => c.body as Record<string, unknown>);
    expect(body.some((b) => b["initial_state"] !== undefined)).toBe(false);
  });

  it("W12a: Public forces the Encrypt toggle off + disabled", async () => {
    render(<App />);
    await waitForRooms();
    fireEvent.click(screen.getByRole("button", { name: "Add space or room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New space" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Public space" }));
    const encBox = screen.getByRole("checkbox", { name: "Encrypt space (E2EE)" }) as HTMLInputElement;
    expect(encBox.disabled).toBe(true);
    expect(encBox.checked).toBe(false);
  });

  it("S9: a very long space name renders IN FULL beside its initials icon (item 6)", async () => {
    const LONG = "The Royal Society for Inordinately Long Space Names";
    const fetchFn = createFakeHomeserver({
      accounts: [ALICE],
      sync: () =>
        makeSyncSnapshot({ userId: ALICE.userId, rooms: [{ roomId: "!spL:hs.test", name: LONG, space: true }] }),
    });
    setSessionManagerForTests(new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn }));
    render(<App />);
    await signIn();
    const btn = await screen.findByRole("button", { name: `Space ${LONG}` });
    // full, unwrapped text in the DOM — not the old two-letter abbreviation
    const nameSpan = btn.querySelector(".space-name");
    expect(nameSpan?.textContent).toBe(LONG);
    // the icon survives, next to (not instead of) the name
    expect(btn.querySelector(".space-ico")?.textContent).toBe("TR");
    expect(btn.className).toContain("has-name");
  });
});

/**
 * W12 item 12 — ONE "+" add button anchored at the bottom of the left rail,
 * opening a unified menu (New space / New room / Discover or join room) whose
 * dialogs reuse the existing create-space markup & behavior. The old separate
 * "New space" + on the rail is gone.
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
} from "@linnet/core";
import { App } from "../App.js";
import { setSessionManagerForTests } from "../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

let controls!: FakeHomeserverControls;

function freshManager(): SessionManager {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () =>
      makeSyncSnapshot({
        userId: ALICE.userId,
        rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev" }],
      }),
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
  await screen.findByText("linnet-dev", { selector: ".roomlist .name" });
}

function openAddMenu(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Add space or room" }));
  return screen.getByTestId("rail-add-menu");
}

describe("W12 item 12 — unified bottom-rail add control", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("single + button anchored at the rail bottom; redundant + removed", async () => {
    render(<App />);
    await signIn();
    const rail = document.querySelector("nav.rail")!;
    const bottom = rail.querySelector(".rail-bottom")!;
    // it is the LAST block of the rail (flex margin-top:auto pins it low)
    expect(rail.lastElementChild).toBe(bottom);
    expect(bottom.querySelector(".rail-add")).toBeTruthy();
    // the old standalone New-space plus is gone
    expect(document.querySelector(".space.add")).toBeNull();
  });

  it("opens one menu offering New space / New room / Discover or join room", async () => {
    render(<App />);
    await signIn();
    const menu = openAddMenu();
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(items).toEqual(["New space", "New room", "Discover or join room"]);
    // click-away + Escape close it (same family as every other menu)
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("rail-add-menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Add space or room" }));
    expect(screen.getByTestId("rail-add-menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("rail-add-menu")).toBeNull());
  });

  it("New space path still creates an m.space through the shared dialog", async () => {
    render(<App />);
    await signIn();
    openAddMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New space" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a new space" });
    expect(dialog.getAttribute("data-position")).toBe("center");
    fireEvent.change(dialog.querySelector("input[aria-label='Space name']") as HTMLInputElement, {
      target: { value: "Fun" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create space" }));
    await waitFor(() =>
      expect(
        controls.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path.endsWith("/createRoom") &&
            JSON.stringify((c.body as Record<string, unknown>)?.["creation_content"]) === '{"type":"m.space"}',
        ),
      ).toBe(true),
    );
    await screen.findByRole("button", { name: "Space Fun" });
  });

  it("New room path creates a plain room with identical dialog shape", async () => {
    render(<App />);
    await signIn();
    openAddMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New room" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a new room" });
    expect(dialog.getAttribute("data-position")).toBe("center");
    // same fields/buttons as the space dialog — consistency was the ask
    expect(dialog.querySelector("input[aria-label='Room name']")).toBeTruthy();
    expect(dialog.querySelector("input[aria-label='Public room']")).toBeTruthy();
    fireEvent.change(dialog.querySelector("input[aria-label='Room name']") as HTMLInputElement, {
      target: { value: "Games" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));
    await waitFor(() =>
      expect(
        controls.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path.endsWith("/createRoom") &&
            (c.body as Record<string, unknown>)?.["name"] === "Games" &&
            (c.body as Record<string, unknown>)["creation_content"] === undefined,
        ),
      ).toBe(true),
    );
    // lands live from the sync push and is auto-selected
    await screen.findByText("Games", { selector: ".roomlist .name" });
    await screen.findByTestId("roomview");
  });

  it("Discover or join room posts /join for the entered address", async () => {
    render(<App />);
    await signIn();
    openAddMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Discover or join room" }));
    const dialog = await screen.findByRole("dialog", { name: "Discover or join room" });
    fireEvent.change(dialog.querySelector("input[aria-label='Room address or alias']") as HTMLInputElement, {
      target: { value: "#party:hs.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    await waitFor(() =>
      expect(
        controls.calls.some(
          (c) => c.method === "POST" && decodeURIComponent(c.path).endsWith("/join/#party:hs.test"),
        ),
      ).toBe(true),
    );
  });
});

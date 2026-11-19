/**
 * W12 item 8 — the "x" (leave) button is gone from room/DM rows; leave,
 * decline and remove-from-space live ONLY in the row context menu (⋯ button
 * or right-click). Escape closes it.
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
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

let controls!: FakeHomeserverControls;

function freshManager(): SessionManager {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () =>
      makeSyncSnapshot({
        userId: ALICE.userId,
        rooms: [
          { roomId: "!a1:hs.test", name: "linnet-dev" },
          { roomId: "!dm1:hs.test", name: "Mel" },
        ],
        direct: ["!dm1:hs.test"],
        invites: [{ roomId: "!in1:hs.test", name: "design-help" }],
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

describe("W12 item 8 — row context menu replaces the ✕", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("no inline x (leave/decline) buttons render next to rooms or DMs", async () => {
    render(<App />);
    await signIn();
    expect(document.querySelector(".row-x")).toBeNull();
    expect(document.querySelector(".row-decline")).toBeNull();
    // but the ⋯ menu affordance exists for every row
    expect(screen.getByRole("button", { name: "Menu for linnet-dev" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Menu for Mel" })).toBeTruthy();
  });

  it("right-click opens the menu; Leave room POSTs /leave and the row goes away", async () => {
    render(<App />);
    await signIn();
    const name = screen.getByText("linnet-dev", { selector: ".roomlist .name" });
    fireEvent.contextMenu(name.closest("button")!);
    const menu = await screen.findByTestId("room-ctx-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    fireEvent.click(within(menu, "Leave room"));
    await waitFor(() =>
      expect(
        controls.calls.some((c) => decodeURIComponent(c.path).endsWith("/rooms/!a1:hs.test/leave")),
      ).toBe(true),
    );
    await waitFor(() => expect(document.querySelector(".roomlist")?.textContent).not.toContain("linnet-dev"));
  });

  it("DM leave also forgets (Leave & forget DM)", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Menu for Mel" }));
    fireEvent.click(within(await screen.findByTestId("room-ctx-menu"), "Leave & forget DM"));
    await waitFor(() => {
      const dec = controls.calls.map((c) => decodeURIComponent(c.path));
      expect(dec.some((p) => p.endsWith("/rooms/!dm1:hs.test/leave"))).toBe(true);
      expect(dec.some((p) => p.endsWith("/rooms/!dm1:hs.test/forget"))).toBe(true);
    });
  });

  it("Escape closes the context menu", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Menu for linnet-dev" }));
    expect(await screen.findByTestId("room-ctx-menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("room-ctx-menu")).toBeNull());
  });
});

function within(scope: HTMLElement, label: string): HTMLElement {
  const hit = Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!hit) throw new Error(`menu item not found: ${label}`);
  return hit;
}

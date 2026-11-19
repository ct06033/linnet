/**
 * W12 item 2 — every dropdown/menu closes on click-away (pointerdown outside)
 * and on Escape. Proven here for the account menu (theme/accent live inside
 * it), the room-row context menu, and the command palette.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
} from "@linnet/core";
import { App } from "../App.js";
import { setSessionManagerForTests } from "../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

function freshManager(): SessionManager {
  return new SessionManager({
    kv: new MemoryKv(),
    secrets: new MemorySecrets(),
    fetchFn: createFakeHomeserver({
      accounts: [ALICE],
      sync: () =>
        makeSyncSnapshot({
          userId: ALICE.userId,
          rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev" }],
        }),
    }),
  });
}

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
  await screen.findByText("linnet-dev", { selector: ".roomlist .name" });
}

describe("W12 item 2 — click-away dismissal", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("account menu: pointerdown outside closes, pointerdown inside keeps it open", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByLabelText(/account menu/i));
    expect(screen.getByRole("menu")).toBeTruthy(); // account menu open
    // inside click does NOT close
    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(screen.queryByRole("menu")).toBeTruthy();
    // outside pointerdown closes
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // and Escape works too (pre-existing)
    fireEvent.click(screen.getByLabelText(/account menu/i));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("room-row context menu: pointerdown outside closes", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Menu for linnet-dev" }));
    expect(await screen.findByTestId("room-ctx-menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("room-ctx-menu")).toBeNull());
  });

  it("command palette: pointerdown outside closes", async () => {
    render(<App />);
    await signIn();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: /command palette/i })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /command palette/i })).toBeNull());
  });
});

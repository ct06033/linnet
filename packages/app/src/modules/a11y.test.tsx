// W8 a11y: modal focus management through useModalA11y on the command palette.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
  await screen.findAllByText("linnet-dev");
}

describe("W8 modal a11y", () => {
  beforeEach(() =>
    setSessionManagerForTests(
      new SessionManager({
        kv: new MemoryKv(),
        secrets: new MemorySecrets(),
        fetchFn: createFakeHomeserver({
          accounts: [ALICE],
          sync: (userId) =>
            makeSyncSnapshot({ userId, rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev" }] }),
        }),
      }),
    ),
  );

  it("F1 opening the palette moves focus inside", async () => {
    render(<App />);
    await signIn();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText(/type a command/i);
    expect(document.activeElement).toBe(input);
  });

  it("F2 Tab at the last control wraps to the first (focus stays trapped)", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByLabelText(/new space/i));
    const palette = await screen.findByRole("dialog", { name: /create a new space/i });
    const items = palette.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    expect(items.length).toBeGreaterThan(1);
    const last = items[items.length - 1] as HTMLElement;
    last.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it("F3 Escape closes the palette", async () => {
    render(<App />);
    await signIn();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: /command palette/i });
    fireEvent.keyDown(palette, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /command palette/i })).toBeNull();
  });
});

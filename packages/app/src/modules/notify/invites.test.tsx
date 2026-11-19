/**
 * W6 — invite handling + notification settings at the app level:
 * Join/Decline wire calls and the settings mute selector persisting.
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
        rooms: [{ roomId: "!dev:hs.test", name: "dev" }],
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
  await screen.findByText("dev", { selector: ".roomlist .name" });
}

describe("W6 invites + notify settings", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("N7: Join button POSTs /join and the row becomes a normal room", async () => {
    render(<App />);
    await signIn();
    expect(screen.getByText("invite")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join design-help" }));
    await waitFor(() =>
      expect(
        controls.calls.some(
          (c) =>
            c.method === "POST" &&
            (decodeURIComponent(c.path).endsWith("/rooms/!in1:hs.test/join") ||
              decodeURIComponent(c.path).endsWith("/join/!in1:hs.test")),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText("invite")).toBeNull());
    await waitFor(() => expect(document.querySelector(".roomlist")?.textContent).toContain("design-help"));
  });

  it("N8: Decline POSTs leave + forget and the row disappears", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Decline design-help" }));
    await waitFor(() => {
      const dec = controls.calls.map((c) => decodeURIComponent(c.path));
      expect(dec.some((p) => p.endsWith("/rooms/!in1:hs.test/leave"))).toBe(true);
      expect(dec.some((p) => p.endsWith("/rooms/!in1:hs.test/forget"))).toBe(true);
    });
    await waitFor(() => expect(document.querySelector(".roomlist")?.textContent).not.toContain("design-help"));
  });

  it("N6: settings mute selector writes the modes map to account_data", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByText("dev", { selector: ".roomlist .name" }));
    fireEvent.click(await screen.findByRole("button", { name: "Room settings" }));
    const select = (await screen.findByLabelText("Room notification mode")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "mute" } });
    await waitFor(() =>
      expect(
        controls.calls.some(
          (c) =>
            c.method === "PUT" &&
            decodeURIComponent(c.path).endsWith("/account_data/im.linnet.notifications") &&
            JSON.stringify((c.body as Record<string, unknown>)["modes"]) === '{"!dev:hs.test":"mute"}',
        ),
      ).toBe(true),
    );
  });
});

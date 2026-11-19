import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
} from "@linnet/core";
import { App } from "./App.js";
import { setSessionManagerForTests } from "./session-context.js";

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
          rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev" }, { roomId: "!dm1:hs.test", name: "Mel" }],
          direct: ["!dm1:hs.test"],
          invites: [{ roomId: "!in1:hs.test", name: "design-help" }],
        }),
    }),
  });
}

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("wave-2 auth shell", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("shows the login form first", async () => {
    render(<App />);
    expect(await screen.findByText("Sign in to Linnet")).toBeTruthy();
  });

  it("bad password surfaces an error, stays on login", async () => {
    render(<App />);
    await screen.findByText("Sign in to Linnet");
    fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("login lands in the live room list with DM + invite sections", async () => {
    render(<App />);
    await signIn();
    expect((await screen.findAllByText("linnet-dev")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("People").length).toBeGreaterThan(0);
    expect(screen.getByText("invite")).toBeTruthy(); // design-help
    expect(screen.getByText("Mel")).toBeTruthy(); // DM section
  });

  it("Ctrl+K palette lists module-registry commands after login", async () => {
    render(<App />);
    await signIn();
    await screen.findAllByText("linnet-dev");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByText("/echo")).toBeTruthy();
  });
});

// W12a regression: a failing first sync must SURFACE in the home placeholder
// instead of hanging forever on "waiting for first sync…".
describe("W12a sync-error surfacing", () => {
  it("rejected token during first sync shows an actionable error, not the hang", async () => {
    const base = createFakeHomeserver({
      accounts: [ALICE],
      sync: (userId) => makeSyncSnapshot({ userId, rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev" }] }),
    });
    const broken = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/sync(\?|$)/.test(url)) {
        return new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "Unrecognised token", soft_logout: false }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return base(input, init);
    }) as unknown as typeof globalThis.fetch;
    setSessionManagerForTests(
      new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: broken }),
    );
    render(<App />);
    await signIn();
    expect(await screen.findByText(/session was rejected/i, {}, { timeout: 20000 })).toBeTruthy();
    expect(screen.queryByText("waiting for first sync…")).toBeNull();
  });
});

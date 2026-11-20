/**
 * W14 item 14 (resizable panes) + item 11 (profile avatar editor) +
 * item 12 (room-settings panel surface).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeHomeserverControls,
} from "@linnet/core";
import { App } from "./App.js";
import { setSessionManagerForTests } from "./session-context.js";
import { clampPane, loadPanes, savePane } from "./modules/settings/panes.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

let controls!: FakeHomeserverControls;
let fake!: ReturnType<typeof createFakeHomeserver>;

function freshManager(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [{ roomId: "!a1:hs.test", name: "linnet-dev", topic: "dev room" }],
      }),
  });
  controls = fake.controls;
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await screen.findByText("linnet-dev", { selector: ".roomlist .name" });
}

describe("W14c panes persistence (pure)", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("clamps to per-pane limits and defaults on garbage", () => {
    expect(clampPane("rail", 10)).toBe(64);
    expect(clampPane("rail", 9999)).toBe(340);
    expect(clampPane("roomlist", 260)).toBe(260);
    expect(clampPane("panel", 120)).toBe(260);
    localStorage.setItem("linnet.panes", "{broken");
    expect(loadPanes().rail).toBe(240);
  });

  it("savePane merges single keys (concurrent hook instances)", () => {
    savePane("rail", 300);
    savePane("panel", 400);
    const p = loadPanes();
    expect(p.rail).toBe(300);
    expect(p.panel).toBe(400);
    expect(p.roomlist).toBe(300); // untouched default
  });
});

describe("W14c shell integration", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    setSessionManagerForTests(freshManager());
    // uploadBytes uses the GLOBAL fetch (not the client transport) — hide the
    // real network behind the SAME fake HS (W4c attachment-test trick)
    vi.stubGlobal("fetch", fake);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSessionManagerForTests(freshManager());
  });

  it("item 14: two gutters between the shell panes, sized via CSS vars", async () => {
    render(<App />);
    await signIn();
    const gutters = document.querySelectorAll(".shell > .gutter");
    expect(gutters.length).toBe(2);
    expect((gutters[0] as HTMLElement).dataset.pane).toBe("rail");
    expect((gutters[1] as HTMLElement).dataset.pane).toBe("roomlist");
    expect(document.documentElement.style.getPropertyValue("--rail")).toBe("240px");
  });

  it("item 14: pointer-drag on a gutter writes the clamped width", async () => {
    render(<App />);
    await signIn();
    const g = document.querySelector('.gutter[data-pane="roomlist"]')!;
    // jsdom has no PointerEvent interface w/ init props (probed) — dispatch
    // real MouseEvent instances under the pointer type names instead.
    g.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 160, bubbles: true }));
    // 300 start + 60px drag
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--roomlist")).toBe("360px"));
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 160, bubbles: true }));
    await waitFor(() => expect(loadPanes().roomlist).toBe(360));
  });

  it("item 11: the account menu carries a profile avatar picker that uploads + sets mxc", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await screen.findByLabelText("Profile avatar file");
    const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
    // jsdom File has no arrayBuffer (archived pitfall) — stub the instance
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]) });
    fireEvent.change(screen.getByLabelText("Profile avatar file"), { target: { files: [file] } });
    const findSet = () =>
      controls.calls.find(
        (c) =>
          c.method === "PUT" &&
          decodeURIComponent(c.path).endsWith("/profile/@alice:hs.test/avatar_url"),
      );
    await waitFor(() => expect(findSet()).toBeTruthy());
    expect(JSON.stringify(findSet()!.body)).toContain("mxc://linnet.test/"); // real mxc from the fake upload
  });

  it("item 12: opening room settings from the gear renders the panel surface beside a resizable column", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByText("linnet-dev", { selector: ".roomlist .name" }).closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Room settings" }));
    const panel = await screen.findByRole("region", { name: /Room settings for/ });
    expect(panel.className).toContain("room-settings");
    const view = screen.getByTestId("roomview");
    expect(view.className).toContain("panel-open");
    expect(document.querySelector(".roomview .gutter[data-pane='panel']")).toBeTruthy();
  });
});

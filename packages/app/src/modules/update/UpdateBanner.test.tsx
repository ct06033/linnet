/**
 * W18 — UpdateBanner unit tests: the renderer is a pure mirror of the main
 * process state machine (a fake bridge stands in for the preload API).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UpdateSnapshot, UpdateState } from "@linnet/core";
import { UpdateBanner, updateStatusText } from "./UpdateBanner.js";
import { clearDismissed, loadDismissed, saveDismissed, useUpdates } from "./useUpdates.js";

interface FakeBridge {
  get(): Promise<UpdateSnapshot>;
  check(): Promise<UpdateState>;
  download(): Promise<{ ok: boolean }>;
  install(): Promise<{ ok: boolean }>;
  setEnabled(on: boolean): Promise<UpdateSnapshot>;
  onEvent(cb: (s: UpdateSnapshot) => void): () => void;
  emit(s: UpdateState): void;
  listenerCount(): number;
  calls: string[];
  snapshot(): UpdateSnapshot;
}

function makeBridge(overrides: Partial<UpdateSnapshot> = {}): FakeBridge {
  let snap: UpdateSnapshot = {
    seq: 0,
    state: { kind: "idle" },
    current: "0.2.0",
    capability: "install-in-app",
    enabled: true,
    ...overrides,
  };
  const listeners: Array<(s: UpdateSnapshot) => void> = [];
  const calls: string[] = [];
  const emit = (s: UpdateState): void => {
    snap = { ...snap, seq: snap.seq + 1, state: s };
    listeners.forEach((l) => l({ ...snap }));
  };
  return {
    calls,
    // Captured at CALL time, resolved later — mirrors real IPC and keeps the
    // stale-get-vs-pushed-event race honest in every test below.
    get: () => Promise.resolve({ ...snap }),
    check: async () => {
      calls.push("check");
      const st: UpdateState = { kind: "available", current: snap.current, version: "9.9.9", url: "https://example.test/999", notes: "" };
      emit(st);
      return st;
    },
    download: async () => {
      calls.push("download");
      return { ok: true };
    },
    install: async () => {
      calls.push("install");
      return { ok: true };
    },
    setEnabled: async (on: boolean) => {
      calls.push(`enabled:${on}`);
      snap = { ...snap, seq: snap.seq + 1, enabled: on };
      return { ...snap };
    },
    onEvent: (cb) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit,
    listenerCount: () => listeners.length,
    snapshot: () => ({ ...snap }),
  };
}

const available = (version = "0.2.1"): UpdateState => ({
  kind: "available",
  current: "0.2.0",
  version,
  url: `https://github.com/ct06033/linnet/releases/tag/v${version}`,
  notes: "stuff",
});

let bridge: FakeBridge;

beforeEach(() => {
  bridge = makeBridge();
  (window as { linnet?: unknown }).linnet = {
    platform: "win32",
    version: "0.2.0",
    updates: bridge,
    openExternal: vi.fn(),
  };
  clearDismissed();
});

afterEach(() => {
  cleanup();
  delete (window as { linnet?: unknown }).linnet;
});

async function bannerShown(): Promise<boolean> {
  await waitFor(() => expect(screen.getByTestId("update-banner")).toBeTruthy());
  return true;
}

describe("UpdateBanner", () => {
  it("renders nothing on the web build (no bridge)", async () => {
    delete (window as { linnet?: unknown }).linnet;
    const { container } = render(<UpdateBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
  });

  it("idle / up-to-date / error states are not banner material", async () => {
    render(<UpdateBanner />);
    bridge.emit({ kind: "up-to-date", current: "0.2.0" });
    bridge.emit({ kind: "error", message: "boom" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("update-banner")).toBeNull();
  });

  it("available + install-in-app: download / view / later buttons", async () => {
    render(<UpdateBanner />);
    bridge.emit(available());
    expect(await bannerShown()).toBe(true);
    expect(screen.getByText(/v0\.2\.1 is available/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("update-download"));
    await waitFor(() => expect(bridge.calls).toContain("download"));
  });

  it("announce-only (deb/rpm): no download button; release link opens externally", async () => {
    bridge = makeBridge({ capability: "announce-only" });
    (window as { linnet?: unknown }).linnet = {
      platform: "linux",
      version: "0.2.0",
      updates: bridge,
      openExternal: vi.fn(),
    };
    render(<UpdateBanner />);
    bridge.emit(available());
    expect(await bannerShown()).toBe(true);
    expect(screen.queryByTestId("update-download")).toBeNull();
    fireEvent.click(screen.getByTestId("update-release-link"));
    const l = (window as unknown as { linnet: { openExternal: ReturnType<typeof vi.fn> } }).linnet.openExternal;
    expect(l).toHaveBeenCalledWith("https://github.com/ct06033/linnet/releases/tag/v0.2.1");
  });

  it("Later dismisses that version; a newer release re-arms the banner", async () => {
    render(<UpdateBanner />);
    bridge.emit(available("0.2.1"));
    await bannerShown();
    fireEvent.click(screen.getByTestId("update-later"));
    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());
    expect(loadDismissed()).toBe("0.2.1");
    // same version again — stays hidden
    bridge.emit(available("0.2.1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("update-banner")).toBeNull();
    // newer version — shows again
    bridge.emit(available("0.2.2"));
    expect(await bannerShown()).toBe(true);
  });

  it("Check now clears the dismissal and re-arms even for the same version", async () => {
    saveDismissed("9.9.9"); // bridge.check() emits 9.9.9
    function Probe() {
      const u = useUpdates();
      return u ? <button onClick={() => void u.checkNow()}>probe-check</button> : null;
    }
    render(<UpdateBanner />);
    render(<Probe />);
    bridge.emit(available("9.9.9"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("update-banner")).toBeNull(); // dismissed, hidden
    fireEvent.click(screen.getByText("probe-check"));
    expect(await bannerShown()).toBe(true); // checkNow re-armed it
    expect(screen.getByText(/v9\.9\.9 is available/)).toBeTruthy();
    expect(bridge.calls).toContain("check");
    expect(loadDismissed()).toBe("");
  });

  it("downloading shows progress instead of actions", async () => {
    render(<UpdateBanner />);
    bridge.emit({ kind: "downloading", version: "0.2.1", percent: 42 });
    expect(await bannerShown()).toBe(true);
    expect(screen.getByTestId("update-progress").textContent).toBe("42%");
    expect(screen.queryByTestId("update-download")).toBeNull();
  });

  it("ready: restart calls install", async () => {
    render(<UpdateBanner />);
    bridge.emit({ kind: "ready", version: "0.2.1", url: "https://example.test" });
    expect(await bannerShown()).toBe(true);
    fireEvent.click(screen.getByTestId("update-restart"));
    await waitFor(() => expect(bridge.calls).toContain("install"));
  });

  it("unmount unsubscribes from bridge events", () => {
    const { unmount } = render(<UpdateBanner />);
    expect(bridge.listenerCount()).toBe(1);
    unmount();
    expect(bridge.listenerCount()).toBe(0);
  });

  it("a stale in-flight get() cannot clobber a pushed event (seq guard)", async () => {
    // The exact W18 race: mount fires get(), which captures state at CALL
    // time; before it resolves, main broadcasts a transition. A naive merge
    // would apply the older get result last and swallow the update.
    const gated = { release: null as ((s: UpdateSnapshot) => void) | null };
    const slowSnap = { seq: 0, state: { kind: "idle" } as UpdateState, current: "0.2.0", capability: "announce-only" as const, enabled: true };
    const listeners: Array<(s: UpdateSnapshot) => void> = [];
    (window as { linnet?: unknown }).linnet = {
      platform: "win32",
      version: "0.2.0",
      updates: {
        get: () => new Promise<UpdateSnapshot>((res) => { gated.release = res; }),
        check: async () => slowSnap.state,
        download: async () => ({ ok: true }),
        install: async () => ({ ok: true }),
        setEnabled: async () => ({ ...slowSnap }),
        onEvent: (cb: (s: UpdateSnapshot) => void) => {
          listeners.push(cb);
          return () => listeners.splice(listeners.indexOf(cb), 1);
        },
      },
      openExternal: () => undefined,
    };
    render(<UpdateBanner />);
    // event wins first
    const newer: UpdateSnapshot = { ...slowSnap, seq: 1, state: available("0.9.0") };
    listeners.forEach((l) => l(newer));
    expect(await bannerShown()).toBe(true);
    // the stale pull lands late and must be a no-op
    gated.release?.({ ...slowSnap });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/v0\.9\.0 is available/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("update-later"));
    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());
  });
});

describe("updateStatusText", () => {
  const snap = (state: UpdateState): UpdateSnapshot => ({
    seq: 0,
    state,
    current: "0.2.0",
    capability: "install-in-app",
    enabled: true,
  });
  it("maps each state kind", () => {
    expect(updateStatusText(snap({ kind: "idle" }))).toBe("v0.2.0");
    expect(updateStatusText(snap({ kind: "checking" }))).toBe("checking…");
    expect(updateStatusText(snap({ kind: "up-to-date", current: "0.2.0" }))).toBe("v0.2.0 (latest)");
    expect(updateStatusText(snap(available("0.3.0")))).toBe("v0.3.0 available");
    expect(updateStatusText(snap({ kind: "downloading", version: "0.3.0", percent: 7 }))).toContain("7%");
    expect(updateStatusText(snap({ kind: "ready", version: "0.3.0", url: "" }))).toBe("v0.3.0 ready to install");
    expect(updateStatusText(snap({ kind: "error", message: "GitHub rate limit hit (try again later)" }))).toContain("rate limit");
  });
});

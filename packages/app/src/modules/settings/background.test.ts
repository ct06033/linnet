/**
 * W19 3a — useBackground hook: mirrors tray pause + autostart over a fake
 * preload tray bridge; hides itself (null) on web build or when main never
 * registered handlers (IPC rejects).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { useBackground } from "./background.js";

interface FakeTray {
  autostartGet(): Promise<boolean>;
  autostartSet(on: boolean): Promise<boolean>;
  pauseGet(): Promise<boolean>;
  onPause(cb: (paused: boolean) => void): () => void;
  pushPause(p: boolean): void;
  calls: string[];
}

function makeTray(initial = { paused: false, autostart: false }): FakeTray {
  const listeners: Array<(p: boolean) => void> = [];
  const calls: string[] = [];
  return {
    calls,
    autostartGet: () => Promise.resolve(initial.autostart),
    autostartSet: (on) => {
      calls.push(`set:${on}`);
      initial.autostart = on;
      return Promise.resolve(on);
    },
    pauseGet: () => Promise.resolve(initial.paused),
    onPause: (cb) => {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    pushPause: (p) => listeners.forEach((l) => l(p)),
  };
}

let tray: FakeTray;

beforeEach(() => {
  tray = makeTray();
  (window as { linnet?: unknown }).linnet = { platform: "win32", version: "0.0.0", tray };
});

afterEach(() => {
  delete (window as { linnet?: unknown }).linnet;
});

describe("useBackground", () => {
  it("null on the web build (no tray bridge)", async () => {
    delete (window as { linnet?: unknown }).linnet;
    const { result } = renderHook(() => useBackground());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });

  it("null when main has no tray (IPC rejects)", async () => {
    (window as { linnet?: unknown }).linnet = {
      platform: "linux",
      version: "0.0.0",
      tray: {
        autostartGet: () => Promise.reject(new Error("No handler registered")),
        autostartSet: () => Promise.reject(new Error("No handler registered")),
        pauseGet: () => Promise.reject(new Error("No handler registered")),
        onPause: () => () => undefined,
      },
    };
    const { result } = renderHook(() => useBackground());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });

  it("hydrates from pauseGet/autostartGet, live-updates on push", async () => {
    const { result } = renderHook(() => useBackground());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.paused).toBe(false);
    expect(result.current!.autostart).toBe(false);
    act(() => tray.pushPause(true)); // tray menu click
    await waitFor(() => expect(result.current!.paused).toBe(true));
  });

  it("setAutostart round-trips through the bridge", async () => {
    const { result } = renderHook(() => useBackground());
    await waitFor(() => expect(result.current).not.toBeNull());
    await act(async () => result.current!.setAutostart(true));
    expect(tray.calls).toContain("set:true");
    expect(result.current!.autostart).toBe(true);
  });

  it("startup paused state is picked up (tray menu used before window open)", async () => {
    tray = makeTray({ paused: true, autostart: true });
    (window as { linnet?: unknown }).linnet = { platform: "win32", version: "0.0.0", tray };
    const { result } = renderHook(() => useBackground());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.paused).toBe(true);
    expect(result.current!.autostart).toBe(true);
  });
});

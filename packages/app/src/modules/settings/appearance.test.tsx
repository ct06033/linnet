// W8 theming: pure resolution/persistence + live switch through the account menu.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
} from "@linnet/core";
import {
  ACCENTS,
  applyToElement,
  getSystemAccent,
  loadAppearance,
  resolveTheme,
  saveAppearance,
  setSystemAccent,
} from "./appearance.js";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

describe("appearance pure logic", () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it("A1 resolveTheme honors explicit modes and system+OS pairing", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("A2 persists round-trip and rejects junk safely", () => {
    saveAppearance({ mode: "rose" as never, accent: "teal" });
    const loaded = loadAppearance();
    expect(loaded.mode).toBe("system"); // invalid mode falls back
    expect(loaded.accent).toBe("teal");
    expect(loaded.density).toBe("compact"); // W12 item 3: absent density falls back
    localStorage.setItem("linnet.appearance", JSON.stringify({ mode: "dark", accent: "rose", density: "relaxed" }));
    expect(loadAppearance()).toEqual({ mode: "dark", accent: "rose", density: "relaxed" });
    localStorage.setItem("linnet.appearance", JSON.stringify({ density: "wide" }));
    expect(loadAppearance().density).toBe("compact"); // junk density rejected
    localStorage.setItem("linnet.appearance", "{not json");
    expect(loadAppearance()).toEqual({ mode: "system", accent: "indigo", density: "compact" });
  });

  it("A3 applyToElement: named accents = data-accent rules ONLY; switching is reversible", () => {
    const props: Record<string, string | undefined> = {};
    const el = {
      dataset: {} as Record<string, string | undefined>,
      style: {
        setProperty: (n: string, v: string) => { props[n] = v; },
        removeProperty: (n: string) => { props[n] = undefined; },
      },
    };
    applyToElement(el, { mode: "dark", accent: "teal" }, false);
    expect(el.dataset.theme).toBe("dark");
    expect(el.dataset.accent).toBe("teal");
    expect(el.dataset.density).toBe("compact"); // W12 item 3 default
    // W21 item 5: teal lives in the CSS rule — the inline channel is RESERVED
    // for accent="system" only (the old one-way inline froze the last pick)
    expect(props["--accent"]).toBeUndefined();
    applyToElement(el, { mode: "dark", accent: "indigo" }, false);
    expect(el.dataset.accent).toBe("indigo");
    applyToElement(el, { mode: "dark", accent: "teal", density: "relaxed" }, false);
    expect(el.dataset.density).toBe("relaxed");
    // the new swatches exist and are selectable via data-accent alone
    for (const id of ["blue", "purple"] as const) {
      applyToElement(el, { mode: "dark", accent: id }, false);
      expect(el.dataset.accent).toBe(id);
    }
  });

  it("A3b W21 item 8: accent=system paints the bridge's OS hex inline", () => {
    const props: Record<string, string | undefined> = {};
    const el = {
      dataset: {} as Record<string, string | undefined>,
      style: {
        setProperty: (n: string, v: string) => { props[n] = v; },
        removeProperty: (n: string) => { props[n] = undefined; },
      },
    };
    setSystemAccent("#123456");
    expect(getSystemAccent()).toBe("#123456");
    applyToElement(el, { mode: "dark", accent: "system" }, false);
    expect(props["--accent"]).toBe("#123456");
    setSystemAccent(null); // OS accents disabled -> nothing inline, CSS default
    applyToElement(el, { mode: "dark", accent: "system" }, false);
    expect(props["--accent"]).toBeUndefined();
  });
});

async function signIn(): Promise<void> {
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
  // room name renders twice (row + header) — settle on any of them
  await screen.findAllByText("linnet-dev");
}

describe("W8 appearance + a11y in the shell", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
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
    );
  });

  it("W1 theme buttons write html data-theme and persist", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByLabelText(/account menu/i));
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(loadAppearance().mode).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("W2 accent swatches switch --accent", async () => {
    render(<App />);
    await signIn();
    fireEvent.click(screen.getByLabelText(/account menu/i));
    const rose = screen.getByRole("button", { name: "Rose" });
    fireEvent.click(rose);
    expect(document.documentElement.dataset.accent).toBe("rose");
    expect(rose.getAttribute("aria-pressed")).toBe("true");
  });

  it("W4 density control sits in the theme menu, sets data-density and persists", async () => {
    render(<App />);
    await signIn();
    expect(document.documentElement.dataset.density).toBe("compact");
    fireEvent.click(screen.getByLabelText(/account menu/i));
    fireEvent.click(screen.getByRole("button", { name: "relaxed" }));
    expect(document.documentElement.dataset.density).toBe("relaxed");
    expect(loadAppearance().density).toBe("relaxed");
    fireEvent.click(screen.getByRole("button", { name: "medium" }));
    expect(document.documentElement.dataset.density).toBe("medium");
    expect(localStorage.getItem("linnet.appearance")).toContain("medium");
  });

  it("W3 a11y: skip link targets the conversation pane; rows carry aria-current", async () => {
    render(<App />);
    await signIn();
    const skip = screen.getByRole("link", { name: /skip to conversation/i });
    expect(skip.getAttribute("href")).toBe("#linnet-main");
    expect(document.getElementById("linnet-main")).toBeTruthy();
    const row = screen.getAllByText("linnet-dev").find((n) => n.closest("button.row"));
    fireEvent.click(row!.closest("button")!);
    await vi.waitFor(() => {
      expect(document.querySelectorAll("button.row[aria-current='true']").length).toBe(1);
    });
  });
});

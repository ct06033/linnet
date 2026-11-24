/**
 * P1 URL previews (OG cards) + inline PDF viewer.
 * The HTML fetcher is injected (setPreviewFetcher) — mirrors the Electron
 * main-process bridge; jsdom has no real object URLs, stubbed per test.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeEventLike,
  type FakeHomeserverControls,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";
import { firstPreviewableUrl, parseOpenGraph, setPreviewFetcher } from "./previews.js";
import { uploadBytes } from "../media/core.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function mk(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!dev:hs.test",
            name: "linnet-dev",
            members: { [ALICE.userId]: "join" },
            events: [],
          },
        ],
      }),
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function signInAndOpenDev(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("linnet-dev");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
}

function pushMsg(content: Record<string, unknown>, eventId: string): void {
  fake.controls.push(ALICE.userId, "!dev:hs.test", {
    type: "m.room.message",
    sender: "@bob:hs.test",
    content,
    event_id: eventId,
    origin_server_ts: Date.now(),
  } as FakeEventLike);
}

describe("P1 OG previews", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(mk());
  });
  afterEach(() => {
    setPreviewFetcher(null);
    setSessionManagerForTests(mk());
  });

  it("parseOpenGraph reads og tags, falls back to <title>, rejects barren pages", () => {
    const meta = parseOpenGraph(
      `<html><head><title>Old Style</title><meta property="og:title" content="The Real Title">
       <meta property="og:description" content="A description."><meta property="og:image" content="/img.png"></head><body>x</body></html>`,
      "https://ex.test/a/b",
    );
    expect(meta).toEqual({
      url: "https://ex.test/a/b",
      title: "The Real Title",
      description: "A description.",
      image: "https://ex.test/img.png",
    });
    expect(parseOpenGraph("<html><head><title>Fallback</title></head></html>", "https://ex.test/")?.title).toBe("Fallback");
    expect(parseOpenGraph("<html><body>nothing</body></html>", "https://ex.test/")).toBeNull();
  });

  it("firstPreviewableUrl skips YouTube, file links and trailing punctuation", () => {
    expect(firstPreviewableUrl("watch https://youtu.be/abc")).toBeNull();
    expect(firstPreviewableUrl("look https://ex.test/page.png")).toBeNull();
    expect(firstPreviewableUrl("nice post https://blog.ex.test/p/1.")).toBe("https://blog.ex.test/p/1");
    expect(firstPreviewableUrl("https://a.ex.test and https://b.ex.test")).toBe("https://a.ex.test");
  });

  it("message with a link renders an OG card once the fetcher answers", async () => {
    setPreviewFetcher(async () =>
      `<html><head><meta property="og:title" content="Kernel Panics"><meta property="og:description" content="weekly nix bits"><meta property="og:image" content="https://blog.ex.test/hi.png"></head></html>`,
    );
    await signInAndOpenDev();
    pushMsg({ msgtype: "m.text", body: "read this: https://blog.ex.test/post/1" }, "$og1");
    const card = await screen.findByTestId("link-preview-blog.ex.test");
    expect(card.querySelector(".lp-title")?.textContent).toBe("Kernel Panics");
    expect(card.querySelector(".lp-desc")?.textContent).toBe("weekly nix bits");
    const img = card.querySelector(".lp-img") as HTMLImageElement;
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("no OG data = no card (silent)", async () => {
    setPreviewFetcher(async () => "<html><body>bare</body></html>");
    await signInAndOpenDev();
    pushMsg({ msgtype: "m.text", body: "visit https://plain.ex.test/x" }, "$og2");
    // W21 item 12: the bare URL is now a real anchor in the plain body…
    await waitFor(() =>
      expect(document.querySelector(".plain a[href=\"https://plain.ex.test/x\"]")).toBeTruthy(),
    );
    // …while a link with no OG data still mints NO preview card (silent).
    expect(document.querySelector(".link-preview")).toBeNull();
  });
});

describe("P1 inline PDF viewer", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:pdf-stub");
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
    setSessionManagerForTests(mk());
  });
  afterEach(() => setSessionManagerForTests(mk()));

  it("pdf file message offers View; click opens the blob iframe overlay; Esc closes", async () => {
    await signInAndOpenDev();
    // upload real bytes through the fake HS so the download route answers
    const client = (await import("../../session-context.js")).getSessionManager().activeClient();
    const mxc = await uploadBytes(client, new TextEncoder().encode("%PDF-1.4 test doc"), "application/pdf");
    pushMsg({ msgtype: "m.file", body: "spec.pdf", url: mxc, info: { mimetype: "application/pdf", size: 17 } }, "$pdf1");
    await screen.findByText("spec.pdf");
    fireEvent.click(screen.getByTestId("pdf-view-$pdf1"));
    const viewer = await screen.findByTestId("pdf-viewer");
    expect(viewer).toBeTruthy();
    const frame = screen.getByTestId("pdf-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("blob:pdf-stub");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("pdf-viewer")).toBeNull());
  });

  it("non-pdf files keep the plain Save row (no View button)", async () => {
    await signInAndOpenDev();
    const client = (await import("../../session-context.js")).getSessionManager().activeClient();
    const mxc = await uploadBytes(client, new TextEncoder().encode("zipzip"), "application/zip");
    pushMsg({ msgtype: "m.file", body: "stuff.zip", url: mxc, info: { mimetype: "application/zip", size: 6 } }, "$zip1");
    await screen.findByText("stuff.zip");
    expect(screen.queryByTestId("pdf-view-$zip1")).toBeNull();
    expect(screen.getByTestId("save-$zip1")).toBeTruthy();
  });
});

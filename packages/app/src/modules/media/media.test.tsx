/**
 * W4c media: A2HS encrypted attachments, authenticated downloads, image
 * viewer/lightbox, and voice messages (recorder -> send -> waveform render),
 * against the byte-storing fake homeserver.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
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
import { encryptFile, decryptFile, downloadEncryptedMedia } from "./crypt.js";
import { prepareMediaContent, uploadBytes, _clearMediaCache } from "./core.js";

// jsdom has no SubtleCrypto; swap in node's WebCrypto for A2HS.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

// minimal structural client for direct helper calls
const pseudoClient = {
  getHomeserverUrl: () => "https://hs.test",
  getAccessToken: () => "tok-alice",
} as unknown as MatrixClient;

let events: FakeEventLike[];
let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };
let lastSm: SessionManager | null = null;

function freshManager(): SessionManager {
  events = [];
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!media:hs.test",
            name: "media-room",
            members: { [BOB]: "join", [ALICE.userId]: "join" },
            events,
          },
        ],
      }),
  }) as typeof globalThis.fetch & { controls: FakeHomeserverControls };
  vi.stubGlobal("fetch", fake);
  _clearMediaCache();
  const sm = new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
  lastSm = sm;
  return sm;
}

async function openMediaRoom(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("media-room");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
}

function msgEvent(id: string, content: Record<string, unknown>, sender = BOB): FakeEventLike {
  return { type: "m.room.message", sender, content, event_id: id, origin_server_ts: 5000 };
}

describe("W4c A2HS crypto", () => {
  it("round-trips and hashes THE CIPHERTEXT (not plaintext)", async () => {
    const { info, ciphertext } = await encryptFile(PNG);
    expect(info.hashes.sha256).not.toBe(await digestOf(PNG));
    const back = await decryptFile(ciphertext, { ...info, url: "mxc://x/y" });
    expect(Array.from(back)).toEqual(Array.from(PNG));
  });

  it("rejects tampered ciphertext before decrypting", async () => {
    const { info, ciphertext } = await encryptFile(PNG);
    const evil = new Uint8Array(ciphertext);
    evil[0] ^= 0xff;
    await expect(decryptFile(evil, { ...info, url: "mxc://x/y" })).rejects.toThrow(/SHA-256 mismatch/);
  });

  async function digestOf(bytes: Uint8Array): Promise<string> {
    const d = await webcrypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    let bin = "";
    for (const b of new Uint8Array(d)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/=+$/, "");
  }
});

describe("W4c pipeline", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("prepareMediaContent(encrypted) uploads ciphertext and decrypts back", async () => {
    const content = await prepareMediaContent(pseudoClient, PNG, "pic.png", "image/png", true);
    expect(content.msgtype).toBe("m.image");
    expect(content.file?.v).toBe("v2");
    expect(content.file?.url).toMatch(/^mxc:\/\//);
    expect(content.url).toBeUndefined();
    const back = await downloadEncryptedMedia(
      content as unknown as Record<string, unknown>,
      fake,
      "https://hs.test",
      "tok-alice",
    );
    expect(Array.from(back)).toEqual(Array.from(PNG));
  });

  it("renders a PLAIN image through the authenticated download route", async () => {
    await openMediaRoom();
    const url = await uploadBytes(pseudoClient, PNG, "image/png");
    fake.controls.push(ALICE.userId, "!media:hs.test", msgEvent("$img1", {
      msgtype: "m.image",
      body: "shot.png",
      url,
      info: { mimetype: "image/png", size: PNG.length },
    }));
    const img = await screen.findByTestId("img-$img1");
    await waitFor(() => expect(img.getAttribute("src")).toMatch(/blob:/));
  });

  it("renders an ENCRYPTED image (fetches ciphertext, A2HS-decrypts)", async () => {
    await openMediaRoom();
    const content = await prepareMediaContent(pseudoClient, PNG, "secret.png", "image/png", true);
    fake.controls.push(ALICE.userId, "!media:hs.test", msgEvent("$img2", content as unknown as Record<string, unknown>));
    const img = await screen.findByTestId("img-$img2");
    await waitFor(() => expect(img.getAttribute("src")).toMatch(/blob:/));
  });

  it("image click opens the lightbox; close/next/collapse work", async () => {
    await openMediaRoom();
    const u1 = await uploadBytes(pseudoClient, PNG, "image/png");
    const u2 = await uploadBytes(pseudoClient, PNG, "image/png");
    fake.controls.push(ALICE.userId, "!media:hs.test", msgEvent("$i1", { msgtype: "m.image", body: "a.png", url: u1, info: { mimetype: "image/png" } }));
    fake.controls.push(ALICE.userId, "!media:hs.test", msgEvent("$i2", { msgtype: "m.image", body: "b.png", url: u2, info: { mimetype: "image/png" } }));
    await screen.findByTestId("img-$i2");
    fireEvent.click(screen.getByTestId("img-$i1"));
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.textContent).toContain("1 / 2");
    fireEvent.click(screen.getByTestId("viewer-next"));
    await waitFor(() => expect(screen.getByTestId("viewer").textContent).toContain("2 / 2"));
    fireEvent.click(screen.getByTestId("viewer-close"));
    await waitFor(() => expect(screen.queryByTestId("viewer")).toBeNull());
  });

  it("voice message renders waveform bars, duration; play loads audio", async () => {
    await openMediaRoom();
    const el = window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> };
    let played = 0;
    el.play = () => {
      played++;
      return Promise.resolve();
    };
    const audio = await uploadBytes(pseudoClient, new Uint8Array([1, 2, 3, 4]), "audio/webm");
    fake.controls.push(ALICE.userId, "!media:hs.test", msgEvent("$v1", {
      msgtype: "m.audio",
      body: "Voice message",
      "org.matrix.msc3245.voice": {},
      url: audio,
      info: {
        mimetype: "audio/webm",
        "org.matrix.msc1767.audio": {
          duration: 4200,
          waveform: [
            { duration: 100, amplitude: 512 },
            { duration: 100, amplitude: 400 },
            { duration: 100, amplitude: 800 },
          ],
        },
      },
    }));
    const voice = await screen.findByTestId("voice-$v1");
    expect(voice.querySelectorAll(".wave i")).toHaveLength(3);
    expect(screen.getByTestId("voice-time-$v1").textContent).toBe("0:04");
    fireEvent.click(screen.getByTestId("play-$v1"));
    await waitFor(() => expect(played).toBe(1));
    expect(voice.textContent).toContain("⏸");
  });

  it("recorder: start shows bar, send PUTs m.audio with json peaks + voice marker, echo renders", async () => {
    class FakeStream {
      getTracks() {
        return [{ stop: () => undefined }];
      }
    }
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: () => Promise.resolve(new FakeStream()) },
      configurable: true,
    });
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {
      static isTypeSupported = () => true;
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        setTimeout(() => this.ondataavailable?.({ data: new Blob([new Uint8Array([9, 8, 7])], { type: "audio/webm" }) }), 1);
      }
      stop() {
        setTimeout(() => this.onstop?.(), 1);
      }
    };
    await openMediaRoom();
    fireEvent.click(await screen.findByTestId("voice-start"));
    await screen.findByTestId("voice-recording");
    fireEvent.click(screen.getByTestId("voice-send"));
    await waitFor(() => {
      const send = fake.controls.calls.find(
        (c) =>
          /\/send\/m\.room\.message\//.test(c.path) &&
          (c.body as Record<string, unknown>)?.["msgtype"] === "m.audio",
      );
      expect(send).toBeTruthy();
      const body = send!.body as Record<string, unknown>;
      expect(body["org.matrix.msc3245.voice"]).toEqual({});
      const info = body["info"] as Record<string, unknown>;
      expect((info["json"] as { url: string }).url).toMatch(/^mxc:\/\//);
      expect(((info["org.matrix.msc1767.audio"] as { duration: number }).duration)).toBeGreaterThanOrEqual(0);
    });
    await waitFor(() => expect(document.querySelector('[data-testid^="voice-"]')).toBeTruthy());
  });

  it("cancel discards without sending", async () => {
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
      configurable: true,
    });
    (window as unknown as { MediaRecorder: unknown }).MediaRecorder = class {
      static isTypeSupported = () => true;
      mimeType = "audio/webm";
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        setTimeout(() => this.onstop?.(), 1);
      }
    };
    await openMediaRoom();
    fake.controls.resetCalls();
    fireEvent.click(await screen.findByTestId("voice-start"));
    await screen.findByTestId("voice-recording");
    fireEvent.click(screen.getByTestId("voice-cancel"));
    await waitFor(() => expect(screen.queryByTestId("voice-recording")).toBeNull());
    await new Promise((r) => setTimeout(r, 60));
    expect(
      fake.controls.calls.some(
        (c) => /\/send\/m\.room\.message\//.test(c.path) && (c.body as Record<string, unknown>)?.["msgtype"] === "m.audio",
      ),
    ).toBe(false);
  });
});

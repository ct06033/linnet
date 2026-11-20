/**
 * W7 — 1:1 call flow over the fake HS to_device relay with a fake WebRTC
 * stack: alice invites bob, bob's monitor rings, answer lands, hangup ends
 * it and both monitors clear. Plus pure stateLabel/peerOf checks.
 */
import { ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CallState } from "matrix-js-sdk/lib/webrtc/call.js";
import {
  createClientSession,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeHomeserverControls,
} from "@linnet/core";
import { getMonitor, peerOf, stateLabel } from "./call.js";
import { installFakeWebRTC } from "../../../test/fake-rtc.js";

const ALICE = { userId: "@alice:hs.test", password: "pa", accessToken: "tok-a" };
const BOB = { userId: "@bob:hs.test", password: "pb", accessToken: "tok-b" };

let ctl!: FakeHomeserverControls;
let alice!: MatrixClient;
let bob!: MatrixClient;
let mAlice!: ReturnType<typeof getMonitor>;
let mBob!: ReturnType<typeof getMonitor>;

beforeAll(async () => {
  installFakeWebRTC(vi);
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE, BOB],
    sync: (userId) =>
      makeSyncSnapshot({
        userId,
        rooms: [
          {
            roomId: "!dm:hs.test",
            name: userId === ALICE.userId ? "bob" : "alice",
            members: userId === ALICE.userId ? { [BOB.userId]: "join" } : { [ALICE.userId]: "join" },
          },
        ],
      }),
  });
  ctl = fetchFn.controls;
  alice = createClientSession({
    homeserverUrl: "https://hs.test",
    accessToken: ALICE.accessToken,
    deviceId: "DA",
    userId: ALICE.userId,
    fetchFn,
  });
  bob = createClientSession({
    homeserverUrl: "https://hs.test",
    accessToken: BOB.accessToken,
    deviceId: "DB",
    userId: BOB.userId,
    fetchFn,
  });
  await Promise.all([
    new Promise<void>((res, rej) => {
      const on = (s: string): void => {
        if (s === "PREPARED" || s === "SYNCING") res();
        if (s === "ERROR") rej(new Error("alice sync error"));
      };
      alice.on(ClientEvent.Sync, on as never);
      alice.startClient({ initialSyncLimit: 25 });
    }),
    new Promise<void>((res, rej) => {
      const on = (s: string): void => {
        if (s === "PREPARED" || s === "SYNCING") res();
        if (s === "ERROR") rej(new Error("bob sync error"));
      };
      bob.on(ClientEvent.Sync, on as never);
      bob.startClient({ initialSyncLimit: 25 });
    }),
  ]);
  mAlice = getMonitor(alice);
  mBob = getMonitor(bob);
  mAlice.start();
  mBob.start();
});

describe("call pure helpers", () => {
  it("stateLabel maps SDK states to product words", () => {
    expect(stateLabel(CallState.Ringing)).toBe("Incoming call");
    expect(stateLabel(CallState.Connected)).toBe("Connected");
    expect(stateLabel(CallState.InviteSent)).toBe("Calling…");
    expect(stateLabel(CallState.Ended)).toBe("Call ended");
  });
  it("peerOf resolves the lone other member", () => {
    expect(peerOf(alice, "!dm:hs.test")).toBe(BOB.userId);
    expect(peerOf(alice, "!nope:hs.test")).toBeNull();
  });
});

describe("W14 item 15 — 1:1 video + screenshare", () => {
  it(
    "video invite rings with video on both sides; screenshare toggles live",
    async () => {
      await mAlice.place("!dm:hs.test", true);
      try {
      expect(mAlice.getSnapshot().video).toBe(true);

      await vi.waitFor(() => expect(mBob.getSnapshot().state).toBe(CallState.Ringing), { timeout: 8000 });

      mBob.answer(true);
      await vi.waitFor(
        () =>
          expect(
            ctl.calls.some(
              (c) =>
                c.method === "PUT" &&
                decodeURIComponent(c.path).includes("/rooms/!dm:hs.test/send/m.call.answer/"),
            ),
          ).toBe(true),
        { timeout: 8000 },
      );

      // bob answered WITH video -> his local media acquired a video track
      await vi.waitFor(() => expect(mBob.getSnapshot().video).toBe(true), { timeout: 8000 });

      // screenshare over the LIVE call (v45 metadata path — both ends are js-sdk 45)
      const now = await mAlice.toggleScreenshare();
      expect(now).toBe(true);
      expect(mAlice.getSnapshot().sharing).toBe(true);
      // second toggle stops it
      const after = await mAlice.toggleScreenshare();
      expect(after).toBe(false);
      expect(mAlice.getSnapshot().sharing).toBe(false);

      } finally {
        // never strand call state between tests (shared clients + monitors!)
        mAlice.hangup();
        mBob.hangup();
        await vi
          .waitFor(() => {
            expect(mAlice.getSnapshot().call).toBeNull();
            expect(mBob.getSnapshot().call).toBeNull();
          }, { timeout: 8000 })
          .catch(() => undefined);
      }
    },
    45000,
  );

  it("toggleScreenshare outside a call refuses with a readable error", async () => {
    expect(mBob.getSnapshot().call).toBeNull();
    await expect(mBob.toggleScreenshare()).rejects.toThrow("not in a call");
  });
});

describe("1:1 call flow (fake RTC + to_device relay)", () => {
  it(
    "invite -> bob rings -> answer -> hangup -> both idle",
    async () => {
      await mAlice.place("!dm:hs.test");

      // invite went out (js-sdk 45 sends VoIP events as ROOM send events)
      await vi.waitFor(
        () =>
          expect(
            ctl.calls.some(
              (c) =>
                c.method === "PUT" &&
                decodeURIComponent(c.path).includes("/rooms/!dm:hs.test/send/m.call.invite/"),
            ),
          ).toBe(true),
        { timeout: 8000 },
      );

      // bob's monitor surfaces the incoming call
      await vi.waitFor(() => expect(mBob.getSnapshot().state).toBe(CallState.Ringing), { timeout: 8000 });

      mBob.answer();
      await vi.waitFor(
        () =>
          expect(
            ctl.calls.some(
              (c) =>
                c.method === "PUT" &&
                decodeURIComponent(c.path).includes("/rooms/!dm:hs.test/send/m.call.answer/"),
            ),
          ).toBe(true),
        { timeout: 8000 },
      );

      // hang up from alice: bob's monitor must fall to idle
      mAlice.hangup();
      await vi.waitFor(() => expect(mBob.getSnapshot().call).toBeNull(), { timeout: 8000 });
      await vi.waitFor(() => expect(mAlice.getSnapshot().call).toBeNull(), { timeout: 8000 });
    },
    30000,
  );

  it("busy: placing a second call while connected is refused", async () => {
    await mAlice.place("!dm:hs.test");
    await vi.waitFor(() => expect(mBob.getSnapshot().state).toBe(CallState.Ringing), { timeout: 8000 });
    await expect(mAlice.place("!dm:hs.test")).rejects.toThrow("already in a call");
    mAlice.hangup();
    await vi.waitFor(() => expect(mBob.getSnapshot().call).toBeNull(), { timeout: 8000 });
  }, 30000);
});

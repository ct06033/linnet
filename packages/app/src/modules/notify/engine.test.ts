/**
 * W6 — engine against fake HS with a real js-sdk client: live timeline
 * notify, snapshot prefs, account_data persistence loop (set -> echo ->
 * engine reloads -> next message suppressed), age/edit guards.
 */
import { ClientEvent, MatrixEvent, type MatrixClient } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeHomeserver,
  createClientSession,
  makeSyncSnapshot,
  type FakeEventLike,
  type FakeHomeserverControls,
} from "@linnet/core";
import { NotificationEngine, type Notification } from "./engine.js";
import { setRoomMode } from "./model.js";

const ALICE = { userId: "@alice:hs.test", password: "pw", accessToken: "tok-alice" };

const msgEv = (over: Partial<FakeEventLike> = {}): FakeEventLike => ({
  type: "m.room.message",
  sender: "@bob:hs.test",
  content: { msgtype: "m.text", body: "hi there" },
  room_id: "!dev:hs.test",
  origin_server_ts: Date.now(),
  ...over,
});

function harness(accountData?: Record<string, Record<string, unknown>>): {
  client: MatrixClient;
  ctl: FakeHomeserverControls;
  seen: Notification[];
  engine: NotificationEngine;
  ready: Promise<void>;
} {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: () =>
      makeSyncSnapshot({
        userId: ALICE.userId,
        rooms: [
          { roomId: "!dev:hs.test", name: "dev", members: { "@bob:hs.test": "join" } },
          { roomId: "!dm:hs.test", name: "Mel" },
        ],
        direct: ["!dm:hs.test"],
        accountData,
      }),
  });
  const client = createClientSession({
    homeserverUrl: "https://hs.test",
    accessToken: ALICE.accessToken,
    deviceId: "DEV1",
    userId: ALICE.userId,
    fetchFn,
  });
  const seen: Notification[] = [];
  const engine = new NotificationEngine(client, { notify: (n) => seen.push(n) });
  const ready = new Promise<void>((resolve, reject) => {
    const onSync = (state: string): void => {
      if (state === "PREPARED") {
        client.removeListener(ClientEvent.Sync, onSync);
        resolve();
      } else if (state === "ERROR") {
        reject(new Error("sync failed"));
      }
    };
    client.on(ClientEvent.Sync, onSync as never);
    client.startClient({ initialSyncLimit: 25 });
  });
  return { client, ctl: fetchFn.controls, seen, engine, ready };
}

let h!: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.engine.stop();
  h.client.stopClient();
});

describe("NotificationEngine (live)", () => {
  it("notifies on a new message in a default-mode room", async () => {
    await h.ready;
    h.engine.start();
    h.ctl.push(ALICE.userId, "!dev:hs.test", msgEv());
    await expect
      .poll(() => h.seen.length, { timeout: 3000 })
      .toBe(1);
    expect(h.seen[0]!.title).toBe("dev");
    expect(h.seen[0]!.body).toBe("bob: hi there");
    expect(h.seen[0]!.roomId).toBe("!dev:hs.test");
  });

  it("snapshot prefs: mute room stays silent, others notify", async () => {
    const hh = harness({
      "im.linnet.notifications": { modes: { "!dev:hs.test": "mute" }, keywords: [] },
    });
    await hh.ready;
    hh.engine.start();
    hh.ctl.push(ALICE.userId, "!dev:hs.test", msgEv());
    hh.ctl.push(ALICE.userId, "!dm:hs.test", msgEv({ room_id: "!dm:hs.test", content: { msgtype: "m.text", body: "yo" } }));
    await expect.poll(() => hh.seen.length, { timeout: 3000 }).toBe(1);
    expect(hh.seen[0]!.roomId).toBe("!dm:hs.test");
    hh.engine.stop();
    hh.client.stopClient();
  });

  it("setRoomMode persists via account_data and the engine picks up the echo", async () => {
    await h.ready;
    h.engine.start();
    await setRoomMode(h.client, "!dev:hs.test", "mute");
    expect(
      h.ctl.calls.some((c) => c.method === "PUT" && decodeURIComponent(c.path).includes("/account_data/im.linnet.notifications")),
    ).toBe(true);
    // wait for the echo to reach the engine (prefs reload), then a message
    await new Promise((r) => setTimeout(r, 400));
    h.ctl.push(ALICE.userId, "!dev:hs.test", msgEv());
    await new Promise((r) => setTimeout(r, 600));
    expect(h.seen.length).toBe(0);
  });

  it("handle(): guards — old events, edits, own sender, focus", async () => {
    await h.ready;
    h.engine.start();
    const room = h.client.getRoom("!dev:hs.test")!;
    const synth = (content: Record<string, unknown>, ts: number, sender = "@bob:hs.test"): MatrixEvent => {
      const ev = new MatrixEvent({
        type: "m.room.message",
        sender,
        content,
        room_id: "!dev:hs.test",
        event_id: `$s${Math.random()}`,
        origin_server_ts: ts,
      } as never);
      // MatrixEvent resolves .sender to a RoomMember via the room on
      // addLiveEvents (direct assignment is swallowed by setUnknownField)
      room.addLiveEvents([ev], { addToState: true });
      return ev;
    };
    // events flow through the RoomEvent.Timeline listener (addLiveEvents
    // emits synchronously); sender resolution to RoomMember happens there
    synth({ msgtype: "m.text", body: "ancient" }, Date.now() - 120_000);
    expect(h.seen.length).toBe(0);
    synth({ msgtype: "m.text", body: "edit", "m.new_content": { body: "x" } }, Date.now());
    expect(h.seen.length).toBe(0);
    synth({ msgtype: "m.text", body: "mine" }, Date.now(), ALICE.userId);
    expect(h.seen.length).toBe(0);

    h.engine.stop();
    const focused = new NotificationEngine(
      h.client,
      { notify: (n) => h.seen.push(n) },
      { isFocused: () => true },
    );
    focused.start();
    synth({ msgtype: "m.text", body: "while open" }, Date.now());
    expect(h.seen.length).toBe(0);
    focused.stop();
    h.engine.start();

    synth({ msgtype: "m.text", body: "fresh" }, Date.now());
    expect(h.seen.length).toBe(1);
  });
});

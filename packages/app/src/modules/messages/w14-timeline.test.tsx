/**
 * W14 timeline wave — Sean's items 9, 10, 11, 13, 1:
 * per-message bottom-right timestamps, day dividers on date change, sender
 * avatar images, ghosted topic in the title bar, and the click-to-play
 * YouTube facade.
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
import { extractYouTubeIds } from "../media/youtube.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

const DAY = 86_400_000;
// local-noon YESTERDAY (fixed-offset ms flake near midnight)
const _y = new Date();
_y.setDate(_y.getDate() - 1);
_y.setHours(12, 0, 0, 0);
const YESTERNOON = _y.getTime();
const THISMORNING = Date.now() - 60_000;

function msg(body: string, sender: string, ts: number, id: string): FakeEventLike {
  return {
    type: "m.room.message",
    sender,
    content: { msgtype: "m.text", body },
    event_id: id,
    origin_server_ts: ts,
  };
}

const EVENTS: FakeEventLike[] = [
  msg("yesterday one", BOB, YESTERNOON, "$y1"),
  msg("yesterday two", BOB, YESTERNOON + 60_000, "$y2"),
  {
    type: "m.room.member",
    sender: BOB,
    state_key: BOB,
    content: { membership: "join", avatar_url: "mxc://hs.test/bobpic" },
    event_id: "$mv",
    origin_server_ts: YESTERNOON,
  },
  msg("today https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx", ALICE.userId, THISMORNING, "$t1"),
  msg("youtu.be link https://youtu.be/9bZkp7q19f0", BOB, THISMORNING + 1, "$t2"),
  msg("not a video https://example.com/watch?v=short", BOB, THISMORNING + 2, "$t3"),
];

let controls!: FakeHomeserverControls;

function freshManager(): SessionManager {
  const fetchFn = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!dev:hs.test",
            name: "linnet-dev",
            topic: "ship it",
            members: { [BOB]: "join" },
            events: EVENTS,
          },
        ],
      }),
  });
  controls = fetchFn.controls;
  void controls;
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn });
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
  await screen.findByText("yesterday one");
}

describe("W14 timeline", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("item 9: every message row carries its own bottom-right timestamp", async () => {
    await signInAndOpenDev();
    // "yesterday two" is NOT the group head (bob's pair groups) yet still times
    const two = screen.getByText("yesterday two").closest(".row")!;
    expect(two.querySelector("time.msg-time")).toBeTruthy();
    expect(two.querySelector(".who")).toBeNull(); // one header for the group
    const times = document.querySelectorAll(".roomview time.msg-time");
    expect(times.length).toBeGreaterThanOrEqual(5);
  });

  it("item 10: a date line appears when the day changes", async () => {
    await signInAndOpenDev();
    const breaks = document.querySelectorAll(".day-break");
    expect(breaks.length).toBeGreaterThanOrEqual(2);
    const labels = Array.from(breaks).map((el) => el.textContent);
    expect(labels).toContain("Yesterday");
    expect(labels).toContain("Today");
    // and they are separators
    expect(document.querySelector(".day-break")?.getAttribute("role")).toBe("separator");
  });

  it("item 11: sender avatars render from the member event (image for bob)", async () => {
    await signInAndOpenDev();
    const bobs = await screen.findAllByText("bob");
    const who = bobs[0]!.closest(".who")!;
    const img = who.querySelector("img.avatar-img") as HTMLImageElement | null;
    expect(img).toBeTruthy();
    expect(img!.src).toContain("bobpic");
  });

  it("item 13: topic sits ghosted in the title bar next to the room name", async () => {
    await signInAndOpenDev();
    const ghost = await screen.findByTestId("room-topic-ghost");
    expect(ghost.textContent).toBe("ship it");
    expect(ghost.closest(".room-header .title")).toBeTruthy();
    expect(document.querySelector(".room-header .sub .topic")).toBeNull();
  });

  it("item 1: youtube links render a click-to-play facade; playing mounts the nocookie iframe", async () => {
    await signInAndOpenDev();
    const facade = await screen.findByTestId("yt-facade-dQw4w9WgXcQ");
    expect(screen.getByTestId("yt-facade-9bZkp7q19f0")).toBeTruthy();
    // non-YouTube host with ?v= stays untouched
    expect(screen.queryByTestId(/^yt-facade-short/)).toBeNull();
    expect(document.querySelectorAll(".yt-embeds").length).toBe(2);
    fireEvent.click(facade);
    const frame = await screen.findByTestId("yt-frame-dQw4w9WgXcQ");
    const iframe = frame.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(iframe.src).toContain("autoplay=1");
  });

  it("item 1: id extraction handles watch/shorts/embed/live/youtu.be + dedupe", () => {
    expect(extractYouTubeIds("https://youtu.be/dQw4w9WgXcQ?t=42")).toEqual(["dQw4w9WgXcQ"]);
    expect(extractYouTubeIds("https://www.youtube.com/shorts/abcdefghijk")).toEqual(["abcdefghijk"]);
    expect(extractYouTubeIds("https://www.youtube.com/embed/abcdefghijk")).toEqual(["abcdefghijk"]);
    expect(extractYouTubeIds("https://www.youtube.com/live/abcdefghijk")).toEqual(["abcdefghijk"]);
    expect(extractYouTubeIds("https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ")).toEqual(["dQw4w9WgXcQ"]);
    expect(
      extractYouTubeIds("a https://youtu.be/dQw4w9WgXcQ b https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toEqual(["dQw4w9WgXcQ"]);
    expect(extractYouTubeIds("https://example.com/watch?v=notyoutube")).toEqual([]);
    expect(extractYouTubeIds("https://www.youtube.com/watch?v=tooshort1")).toEqual([]);
  });
});

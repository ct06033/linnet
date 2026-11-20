/**
 * W4a roomview integration: drives the real js-sdk client over the upgraded
 * fake homeserver (long-poll sync + echo fanout). Covers open, grouping,
 * edits, replies, reactions, sending + undo + failure retry, typing,
 * receipts, pagination, /me, markdown, shortcodes, mentions, attachments,
 * UTD and drafts — per docs/qa dev-exit items for the messaging core.
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
  type FakeRoom,
} from "@linnet/core";
import { App } from "../../App.js";
import { setSessionManagerForTests } from "../../session-context.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

const DEV_OLD: FakeEventLike[] = [
  {
    type: "m.room.message",
    sender: BOB,
    content: { msgtype: "m.text", body: "THE-FIRST-OLDER-MESSAGE" },
    event_id: "$old1",
    origin_server_ts: 10,
  },
];

function devRoom(events: FakeEventLike[]): FakeRoom {
  return {
    roomId: "!dev:hs.test",
    name: "linnet-dev",
    topic: "main dev room",
    members: { [BOB]: "join", "@carol:hs.test": "join" },
    events,
    old: DEV_OLD,
  };
}

function seeded(): FakeEventLike[] {
  return [
    {
      type: "m.room.message",
      sender: BOB,
      content: { msgtype: "m.text", body: "morning all" },
      event_id: "$s1",
      origin_server_ts: 1000,
    },
    {
      type: "m.room.message",
      sender: BOB,
      content: { msgtype: "m.text", body: "second msg" },
      event_id: "$s2",
      origin_server_ts: 2000,
    },
    {
      type: "m.room.member",
      sender: "@carol:hs.test",
      state_key: "@carol:hs.test",
      content: { membership: "join" },
      event_id: "$s3",
      origin_server_ts: 2500,
    },
    {
      type: "m.room.message",
      sender: ALICE.userId,
      content: { msgtype: "m.text", body: "orig" },
      event_id: "$s4",
      origin_server_ts: 3000,
    },
    {
      type: "m.room.message",
      sender: ALICE.userId,
      content: {
        msgtype: "m.text",
        body: "* orig edited text",
        "m.new_content": { msgtype: "m.text", body: "edited text" },
        "m.relates_to": { rel_type: "replace", event_id: "$s4" },
      },
      event_id: "$s5",
      origin_server_ts: 3100,
    },
    {
      type: "m.reaction",
      sender: BOB,
      content: {
        "m.relates_to": { rel_type: "annotation", event_id: "$s1", key: "👍" },
        value: "👍",
      },
      event_id: "$s6",
      origin_server_ts: 3200,
    },
    {
      type: "m.room.message",
      sender: BOB,
      content: {
        msgtype: "m.text",
        body: "> <@alice:hs.test> orig\n\nreplied!",
        "m.relates_to": { "m.in_reply_to": { event_id: "$s4" } },
      },
      event_id: "$s7",
      origin_server_ts: 4000,
    },
    {
      type: "m.room.encrypted",
      sender: BOB,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "xx", sender_key: "aa", session_id: "s" },
      event_id: "$s8",
      origin_server_ts: 4500,
    },
  ];
}

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function freshManager(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [devRoom(seeded()), { roomId: "!other:hs.test", name: "other-room" }],
      }),
    roomsLookup: () => [{ roomId: "!dev:hs.test", old: DEV_OLD }],
  });
  vi.stubGlobal("fetch", fake);
  return new SessionManager({
    kv: new MemoryKv(),
    secrets: new MemorySecrets(),
    fetchFn: fake,
  });
}

async function clickRoomRow(name: string): Promise<void> {
  const matches = await screen.findAllByText(name);
  const rowSpan = matches.find((el) => el.closest(".roomlist"));
  expect(rowSpan).toBeTruthy();
  fireEvent.click(rowSpan!);
}

async function signInAndOpenDev(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  await clickRoomRow("linnet-dev");
  await screen.findByTestId("roomview");
}

function typeMessage(text: string): void {
  const box = screen.getByLabelText("Message");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

describe("W4a roomview", () => {
  beforeEach(() => {
    // js-sdk uploadContent prefers XMLHttpRequest when present; hide it so the
    // fetch seam (fake homeserver) owns uploads in jsdom
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("opens a room: header, topic, grouping, system lines, edit badge, quote, utd", async () => {
    await signInAndOpenDev();
    // header
    expect(await screen.findByText("main dev room")).toBeTruthy();
    expect(screen.getAllByText("linnet-dev").length).toBeGreaterThan(0);
    // seeded messages render
    expect(await screen.findByText("morning all")).toBeTruthy();
    expect(screen.findByText("second msg")).toBeTruthy();
    // sender grouping: bob's two messages share one header
    const who = document.querySelectorAll(".row.head .who strong");
    expect(Array.from(who).map((el) => el.textContent)).toContain("bob");
    // system line
    expect(screen.getByText("carol joined")).toBeTruthy();
    // edit aggregation: shows new content + badge, not a duplicate stream row
    expect(screen.getByText("edited text")).toBeTruthy();
    expect(screen.getByText("(edited)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("* orig edited text");
    // reaction pill aggregated
    expect(await screen.findByText(/👍 1/)).toBeTruthy();
    // reply quote chip (fallback text stripped)
    expect(screen.getByText("replied!")).toBeTruthy();
    expect(screen.getByText(/↳ alice: orig/)).toBeTruthy();
    // UTD placeholder
    expect(screen.getByText(/Unable to decrypt/)).toBeTruthy();
    // read receipt sent for bob's newest event
    await waitFor(() =>
      expect(fake.controls.calls.some((c) => c.path.includes("/receipt/m.read/"))).toBe(true),
    );
  });

  it("send → echo → undo → redaction tombstone", async () => {
    await signInAndOpenDev();
    typeMessage("brand new message");
    expect(await screen.findByText("brand new message")).toBeTruthy();
    const undo = await screen.findByTestId("undo-bar");
    fireEvent.click(undo.querySelector("button")!);
    await waitFor(() =>
      expect(fake.controls.calls.some((c) => /\/redact\//.test(c.path))).toBe(true),
    );
    expect(await screen.findByText("Message deleted")).toBeTruthy();
  });

  it("failed send offers retry that succeeds", async () => {
    await signInAndOpenDev();
    fake.controls.failNextSend(403, "M_FORBIDDEN");
    typeMessage("doomed message");
    expect(await screen.findByText(/^failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    // second attempt has no injected failure → echo lands
    expect(await screen.findByText("doomed message", undefined, { timeout: 2000 })).toBeTruthy();
  });

  it("edits an own message via composer edit mode", async () => {
    await signInAndOpenDev();
    await screen.findByText("edited text");
    // find $s4 row and click its Edit action
    const rows = Array.from(document.querySelectorAll(".row"));
    const s4Row = rows.find((r) => r.querySelector('[data-testid="msg-$s4"]'));
    expect(s4Row).toBeTruthy();
    fireEvent.click(s4Row!.querySelector('[aria-label="Edit"]')!);
    const box = await screen.findByLabelText("Message");
    expect((box as HTMLTextAreaElement).value).toBe("edited text");
    fireEvent.change(box, { target: { value: "corrected again" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("corrected again")).toBeTruthy();
    // still one line with the edited badge (no duplicate)
    expect(document.querySelectorAll('[data-testid="msg-$s4"]').length).toBe(1);
  });

  it("replies: banner, fallback quote, rendered chip", async () => {
    await signInAndOpenDev();
    await screen.findByText("morning all");
    const rows = Array.from(document.querySelectorAll(".row"));
    const s1Row = rows.find((r) => r.querySelector('[data-testid="msg-$s1"]'));
    fireEvent.click(s1Row!.querySelector('[aria-label="Reply"]')!);
    expect(await screen.findByText(/Replying to bob/)).toBeTruthy();
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "my reply text" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("my reply text")).toBeTruthy();
    const chips = Array.from(document.querySelectorAll(".reply-quote"));
    expect(chips.some((c) => c.textContent?.includes("bob: morning all"))).toBe(true);
  });

  it("quick-reaction adds pill (mine)", async () => {
    await signInAndOpenDev();
    await screen.findByText("second msg");
    const rows = Array.from(document.querySelectorAll(".row"));
    const s2Row = rows.find((r) => r.querySelector('[data-testid="msg-$s2"]'));
    fireEvent.click(s2Row!.querySelector('[aria-label="react 🎉"]')!);
    expect(await screen.findByText(/🎉 1/)).toBeTruthy();
  });

  it("typing indicator from ephemeral", async () => {
    await signInAndOpenDev();
    await screen.findByText("morning all");
    fake.controls.pushTyping(ALICE.userId, "!dev:hs.test", [BOB]);
    expect(await screen.findByText(/bob is typing…/, undefined, { timeout: 2000 })).toBeTruthy();
  });

  it("live message pushed while room is open", async () => {
    await signInAndOpenDev();
    await screen.findByText("morning all");
    fake.controls.push(ALICE.userId, "!dev:hs.test", {
      type: "m.room.message",
      sender: BOB,
      content: { msgtype: "m.text", body: "arrives live" },
      event_id: "$live1",
    });
    expect(await screen.findByText("arrives live")).toBeTruthy();
  });

  it("pagination loads older history", async () => {
    await signInAndOpenDev();
    await screen.findByText("morning all");
    fireEvent.click(await screen.findByText("Load earlier messages"));
    expect(await screen.findByText("THE-FIRST-OLDER-MESSAGE")).toBeTruthy();
    expect(fake.controls.calls.some((c) => c.path.includes("/messages"))).toBe(true);
  });

  it("/me slash command sends emote via registry seam", async () => {
    await signInAndOpenDev();
    typeMessage("/me waves hello");
    const emote = await screen.findByText("waves hello");
    expect(emote.closest(".msg-emote")).toBeTruthy();
  });

  it("rich composer produces sanitized markdown html", async () => {
    await signInAndOpenDev();
    await screen.findByText("morning all");
    fireEvent.click(screen.getByLabelText("toggle formatting"));
    typeMessage("**bold claim** and `code`");
    const msg = await screen.findByText("bold claim");
    expect(msg.closest("strong")).toBeTruthy();
    expect(document.querySelector(".msg .formatted code")).toBeTruthy();
  });

  it("emoji shortcodes expand on send", async () => {
    await signInAndOpenDev();
    typeMessage("shipped :tada:");
    expect(await screen.findByText("shipped 🎉")).toBeTruthy();
  });

  it("@room sets room mention when powered", async () => {
    await signInAndOpenDev();
    typeMessage("@room attention everyone");
    await screen.findByText("@room attention everyone");
    const send = fake.controls.calls.find((c) => /\/send\/m\.room\.message\//.test(c.path));
    const content = send?.body as Record<string, unknown>;
    expect((content["m.mentions"] as Record<string, unknown>)["room"]).toBe(true);
  });

  it("attaches a file through upload + m.image", async () => {
    await signInAndOpenDev();
    const file = new File(["tiny"], "shot.png", { type: "image/png" });
    const input = screen.getByLabelText("Attach file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByAltText("shot.png")).toBeTruthy();
    expect(fake.controls.calls.some((c) => c.path.includes("/upload"))).toBe(true);
  });

  it("drafts persist across room switches", async () => {
    await signInAndOpenDev();
    await screen.findByText("morning all");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "half-typed thought" } });
    await clickRoomRow("other-room");
    await clickRoomRow("linnet-dev");
    await screen.findByText("morning all");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half-typed thought");
  });

  it("encrypted room shows lock badge", async () => {
    // fresh render with an encrypted seeded room is covered by W5a UI tests;
    // here assert the badge element exists for !dev when encryption state arrives
    fake.controls.push(ALICE.userId, "!dev:hs.test", {
      type: "m.room.encryption",
      sender: ALICE.userId,
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
      event_id: "$enc1",
    });
    await signInAndOpenDev();
    expect(await screen.findByText("morning all")).toBeTruthy();
    expect(document.querySelector(".e2ee-badge")).toBeTruthy();
  });

  it("W14: unencrypted room shows the loud 'Not encrypted' badge; click opens room settings", async () => {
    await signInAndOpenDev();
    const badge = await screen.findByTestId("security-banner");
    expect(badge.textContent).toContain("Not encrypted");
    expect(badge.querySelector("svg.lock-off")).toBeTruthy();
    fireEvent.click(badge);
    await screen.findByRole("region", { name: /Room settings/ });
  });
});

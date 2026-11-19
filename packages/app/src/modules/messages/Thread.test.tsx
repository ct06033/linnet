/**
 * W4b1 thread integration: badge on root, docked panel with thread-scoped
 * composer, MSC3440 relation sends, live increments, Esc close, and main
 * composer thread-joining — against the long-poll fake homeserver.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";

function threadReply(id: string, sender: string, body: string, ts: number): FakeEventLike {
  return {
    type: "m.room.message",
    sender,
    content: {
      msgtype: "m.text",
      body: `> <@bob:hs.test> THREAD-ROOT-BODY\n\n${body}`,
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: "$root1",
        is_falling_back: true,
        "m.in_reply_to": { event_id: "$root1" },
      },
    },
    event_id: id,
    origin_server_ts: ts,
  };
}

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };
let lastSm: SessionManager | null = null;

function freshManager(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!t:hs.test",
            name: "threads-room",
            members: { [BOB]: "join", "@carol:hs.test": "join" },
            events: [
              {
                type: "m.room.message",
                sender: BOB,
                content: { msgtype: "m.text", body: "THREAD-ROOT-BODY" },
                event_id: "$root1",
                origin_server_ts: 1000,
              },
              threadReply("$tr1", ALICE.userId, "first thread reply", 2000),
              threadReply("$tr2", "@carol:hs.test", "second thread reply", 3000),
              {
                type: "m.room.message",
                sender: BOB,
                content: { msgtype: "m.text", body: "PLAIN-MAIN-MESSAGE" },
                event_id: "$plain1",
                origin_server_ts: 4000,
              },
            ],
          },
        ],
      }),
  });
  const sm = new SessionManager({
    kv: new MemoryKv(),
    secrets: new MemorySecrets(),
    fetchFn: fake,
  });
  lastSm = sm;
  return sm;
}

async function openThreadsRoom(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("threads-room");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
  await screen.findByText("THREAD-ROOT-BODY");
}

describe("W4b1 threads", () => {
  beforeEach(() => setSessionManagerForTests(freshManager()));
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("root shows reply badge; replies hidden from main stream", async () => {
    await openThreadsRoom();
    const badge = await screen.findByTestId("thread-badge-$root1");
    expect(badge.textContent).toContain("2 replies");
    expect(document.body.textContent).toContain("PLAIN-MAIN-MESSAGE");
    expect(document.body.textContent).not.toContain("first thread reply");
  });

  it("badge click opens panel with root + replies; Esc closes", async () => {
    await openThreadsRoom();
    fireEvent.click(await screen.findByTestId("thread-badge-$root1"));
    const panel = await screen.findByTestId("thread-panel");
    expect(panel.textContent).toContain("2 replies");
    expect(panel.textContent).toContain("first thread reply");
    expect(panel.textContent).toContain("second thread reply");
    expect(screen.getByLabelText("Reply to thread")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("thread-panel")).toBeNull());
  });

  it("panel composer sends MSC3440 thread relation", async () => {
    await openThreadsRoom();
    fireEvent.click(await screen.findByTestId("thread-badge-$root1"));
    const box = await screen.findByLabelText("Reply to thread");
    fireEvent.change(box, { target: { value: "reply from panel" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(
        fake.controls.calls.some((c) => {
          const body = c.body as Record<string, unknown>;
          const rel = body?.["m.relates_to"] as Record<string, unknown> | undefined;
          return rel?.["rel_type"] === "m.thread" && rel?.["event_id"] === "$root1";
        }),
      ).toBe(true),
    );
    expect(await screen.findByText("reply from panel")).toBeTruthy();
  });

  it("pushed reply increments the badge live", async () => {
    await openThreadsRoom();
    expect((await screen.findByTestId("thread-badge-$root1")).textContent).toContain("2 replies");
    fake.controls.push(ALICE.userId, "!t:hs.test", threadReply("$tr3", BOB, "third reply", 9000));
    await waitFor(() =>
      expect((screen.getByTestId("thread-badge-$root1") as HTMLElement).textContent).toContain("3 replies"),
    );
  });

  it("replying to a thread root from the main composer joins the thread", async () => {
    await openThreadsRoom();
    const rows = Array.from(document.querySelectorAll(".row"));
    const rootRow = rows.find((r) => r.querySelector('[data-testid="msg-$root1"]'));
    expect(rootRow).toBeTruthy();
    fireEvent.click(rootRow!.querySelector('[aria-label="Reply"]')!);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "threaded from main" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(
        fake.controls.calls.some((c) => {
          const body = c.body as Record<string, unknown>;
          const rel = body?.["m.relates_to"] as Record<string, unknown> | undefined;
          return rel?.["rel_type"] === "m.thread" && rel?.["event_id"] === "$root1";
        }),
      ).toBe(true),
    );
  });

  it("replying to a plain message stays a plain in_reply_to", async () => {
    await openThreadsRoom();
    const rows = Array.from(document.querySelectorAll(".row"));
    const plainRow = rows.find((r) => r.querySelector('[data-testid="msg-$plain1"]'));
    fireEvent.click(plainRow!.querySelector('[aria-label="Reply"]')!);
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "plain reply here" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(
        fake.controls.calls.some((c) => {
          const body = c.body as Record<string, unknown>;
          const rel = body?.["m.relates_to"] as Record<string, unknown> | undefined;
          return rel !== undefined && rel["rel_type"] === undefined && (rel["m.in_reply_to"] as { event_id?: string })?.event_id === "$plain1";
        }),
      ).toBe(true),
    );
  });
});

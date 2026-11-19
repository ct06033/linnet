/**
 * W4b2 polls: MSC3381 create → vote → live tally → end, plus aggregation
 * unit tests (latest-vote-wins, multi-answer, end refs).
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
import { aggregatePolls, makeEvent } from "./model.js";

const ALICE = { userId: "@alice:hs.test", password: "pw-alice", accessToken: "tok-alice" };
const BOB = "@bob:hs.test";
const CAROL = "@carol:hs.test";

function pollVote(id: string, sender: string, target: string, answers: string[], ts: number): FakeEventLike {
  return {
    type: "m.poll.response",
    sender,
    content: { "m.relates_to": { rel_type: "m.reference", event_id: target }, answers },
    event_id: id,
    origin_server_ts: ts,
  };
}

let fake: typeof globalThis.fetch & { controls: FakeHomeserverControls };

function freshManager(): SessionManager {
  fake = createFakeHomeserver({
    accounts: [ALICE],
    sync: (uid) =>
      makeSyncSnapshot({
        userId: uid,
        rooms: [
          {
            roomId: "!p:hs.test",
            name: "polls-room",
            members: { [BOB]: "join", [CAROL]: "join" },
            events: [
              {
                type: "m.poll.start",
                sender: BOB,
                content: {
                  question: { body: "Dinner pick" },
                  answers: [
                    { id: "1", body: "pizza" },
                    { id: "2", body: "sushi" },
                  ],
                  max_selections: 1,
                },
                event_id: "$poll1",
                origin_server_ts: 1000,
              },
              pollVote("$pv1", CAROL, "$poll1", ["1"], 1500),
            ],
          },
        ],
      }),
  });
  return new SessionManager({ kv: new MemoryKv(), secrets: new MemorySecrets(), fetchFn: fake });
}

async function openPollsRoom(): Promise<void> {
  render(<App />);
  await screen.findByText("Sign in to Linnet");
  fireEvent.change(screen.getByLabelText(/Homeserver/i), { target: { value: "https://hs.test" } });
  fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: ALICE.userId } });
  fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: ALICE.password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
  const matches = await screen.findAllByText("polls-room");
  fireEvent.click(matches.find((el) => el.closest(".roomlist"))!);
  await screen.findByTestId("roomview");
}

describe("W4b2 polls UI", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    setSessionManagerForTests(freshManager());
  });
  afterEach(() => setSessionManagerForTests(freshManager()));

  it("renders poll card with current tally", async () => {
    await openPollsRoom();
    const card = await screen.findByTestId("poll-$poll1");
    expect(card.textContent).toContain("Dinner pick");
    expect(card.textContent).toContain("pizza");
    expect(card.textContent).toContain("1 vote");
    // responses are not separate stream rows (scope: timeline rows only)
    expect(document.querySelectorAll(".scroller .row").length).toBe(1);
  });

  it("voting sends m.poll.response and updates tally with mine marker", async () => {
    await openPollsRoom();
    fireEvent.click(await screen.findByLabelText("Vote: sushi"));
    await waitFor(() =>
      expect(
        fake.controls.calls.some((c) => {
          const b = c.body as Record<string, unknown>;
          const rel = b?.["m.relates_to"] as Record<string, unknown> | undefined;
          return c.path.includes("/send/m.poll.response/") && rel?.["event_id"] === "$poll1" && (b["answers"] as string[])[0] === "2";
        }),
      ).toBe(true),
    );
    await waitFor(() => {
      const card = screen.getByTestId("poll-$poll1");
      expect(card.textContent).toContain("2 votes");
      expect(card.textContent).toContain("☑ sushi");
    });
  });

  it("pushed vote updates tally live", async () => {
    await openPollsRoom();
    await screen.findByTestId("poll-$poll1");
    fake.controls.push(ALICE.userId, "!p:hs.test", pollVote("$pv2", BOB, "$poll1", ["2"], 9000));
    await waitFor(() =>
      expect(screen.getByTestId("poll-$poll1").textContent).toContain("2 votes"),
    );
  });

  it("/poll creates via editor, own poll can be ended", async () => {
    await openPollsRoom();
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "/poll Best era" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const editor = await screen.findByTestId("poll-editor");
    expect(editor).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Poll option 1"), { target: { value: "seventies" } });
    fireEvent.change(screen.getByLabelText("Poll option 2"), { target: { value: "nineties" } });
    fireEvent.click(screen.getByLabelText("Create poll"));
    await waitFor(() =>
      expect(
        fake.controls.calls.some((c) => {
          const b = c.body as Record<string, unknown>;
          return (
            c.path.includes("/send/m.poll.start/") &&
            (b["question"] as { body: string }).body === "Best era" &&
            (b["answers"] as unknown[]).length === 2
          );
        }),
      ).toBe(true),
    );
    const mine = await screen.findByTestId(/poll-\$evt/);
    expect(mine.textContent).toContain("Best era");
    fireEvent.click(screen.getByLabelText("End poll"));
    await waitFor(() =>
      expect(fake.controls.calls.some((c) => c.path.includes("/send/m.poll.end/"))).toBe(true),
    );
    await waitFor(() => expect(mine.textContent).toContain("ended"));
  });
});

describe("aggregatePolls (pure)", () => {
  const mkStart = (): FakeEventLike => ({
    type: "m.poll.start",
    sender: BOB,
    content: {
      question: { body: "Q" },
      answers: [
        { id: "a", body: "A" },
        { id: "b", body: "B" },
      ],
      max_selections: 2,
    },
    event_id: "$s",
    origin_server_ts: 1,
  });

  it("latest vote per user wins", () => {
    const evs = [
      makeEvent(mkStart() as never),
      makeEvent({ type: "m.poll.response", sender: ALICE.userId, content: { "m.relates_to": { rel_type: "m.reference", event_id: "$s" }, answers: ["a"] }, event_id: "$r1", ts: 2 }),
      makeEvent({ type: "m.poll.response", sender: ALICE.userId, content: { "m.relates_to": { rel_type: "m.reference", event_id: "$s" }, answers: ["b"] }, event_id: "$r2", ts: 3 }),
    ];
    const polls = aggregatePolls(evs, ALICE.userId);
    const p = polls.get("$s")!;
    expect(p.votes.get("b")).toBe(1);
    expect(p.votes.get("a")).toBeUndefined();
    expect(p.myVote).toEqual(["b"]);
    expect(p.voters.size).toBe(1);
    expect(p.start.maxSelections).toBe(2);
  });

  it("end flips state; unknown targets ignored", () => {
    const evs = [
      makeEvent(mkStart() as never),
      makeEvent({ type: "m.poll.end", sender: BOB, content: { "m.relates_to": { rel_type: "m.reference", event_id: "$s" } }, event_id: "$e", ts: 5 }),
      makeEvent({ type: "m.poll.response", sender: CAROL, content: { "m.relates_to": { rel_type: "m.reference", event_id: "$zz" }, answers: ["a"] }, event_id: "$r9", ts: 6 }),
    ];
    const polls = aggregatePolls(evs, ALICE.userId);
    expect(polls.get("$s")!.ended).toBe(true);
    expect(polls.get("$s")!.endedBy).toBe(BOB);
    expect(polls.size).toBe(1);
  });
});

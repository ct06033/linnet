import { describe, expect, it } from "vitest";
import type { Room } from "matrix-js-sdk";
import {
  aggregateReactions,
  canNotifyRoom,
  detectMentions,
  groupEvents,
  kindOf,
  latestEdits,
  makeEvent,
  replyTargetId,
} from "./model.js";

const ALICE = "@alice:hs.test";
const BOB = "@bob:hs.test";

describe("kindOf", () => {
  it("classifies messages", () => {
    expect(kindOf(makeEvent({ type: "m.room.message", sender: ALICE, content: { msgtype: "m.text", body: "hi" } }))).toBe("text");
    expect(kindOf(makeEvent({ type: "m.room.message", sender: ALICE, content: { msgtype: "m.notice", body: "hi" } }))).toBe("notice");
    expect(kindOf(makeEvent({ type: "m.room.message", sender: ALICE, content: { msgtype: "m.image", body: "f.png" } }))).toBe("image");
    expect(kindOf(makeEvent({ type: "m.room.member", sender: BOB, content: { membership: "join" }, state_key: BOB }))).toBe("system");
    expect(kindOf(makeEvent({ type: "m.room.encrypted", sender: BOB, content: { algorithm: "m.megolm.v1.aes-sha2" } }))).toBe("utd");
    expect(kindOf(makeEvent({ type: "m.room.message", sender: ALICE, content: { msgtype: "m.text", body: "x" }, redacted_because: { event_id: "$r" } as never }))).toBe("redacted");
    expect(kindOf(makeEvent({ type: "m.reaction", sender: ALICE, content: { "m.relates_to": { rel_type: "annotation", key: "👍" } } }))).toBe("reaction");
  });
});

describe("groupEvents", () => {
  it("groups same sender within 5 min, splits system lines", () => {
    const a1 = makeEvent({ type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "1" }, ts: 1000 });
    const a2 = makeEvent({ type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "2" }, ts: 2000 });
    const b = makeEvent({ type: "m.room.message", sender: ALICE, content: { msgtype: "m.text", body: "3" }, ts: 3000 });
    const sys = makeEvent({ type: "m.room.member", sender: BOB, content: { membership: "join" }, state_key: BOB, ts: 3500 });
    const a3 = makeEvent({ type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "4" }, ts: 4000 });
    const groups = groupEvents([a1, a2, b, sys, a3]);
    expect(groups.length).toBe(4);
    expect(groups[0]!.events.length).toBe(2);
    expect(groups[2]!.events.length).toBe(1);
    expect(groups[3]!.events.length).toBe(1);
  });

  it("splits beyond the window", () => {
    const a = makeEvent({ type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "1" }, ts: 0 });
    const b = makeEvent({ type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "2" }, ts: 6 * 60_000 + 1000 });
    expect(groupEvents([a, b]).length).toBe(2);
  });
});

describe("latestEdits", () => {
  it("aggregates to newest replacement", () => {
    const target = makeEvent({ type: "m.room.message", sender: ALICE, content: { msgtype: "m.text", body: "orig" }, event_id: "$t", ts: 1 });
    const e1 = makeEvent({
      type: "m.room.message",
      sender: ALICE,
      content: { msgtype: "m.text", body: "* orig e1", "m.new_content": { msgtype: "m.text", body: "e1" }, "m.relates_to": { rel_type: "replace", event_id: "$t" } },
      event_id: "$e1",
      ts: 2,
    });
    const e2 = makeEvent({
      type: "m.room.message",
      sender: ALICE,
      content: { msgtype: "m.text", body: "* orig e2", "m.new_content": { msgtype: "m.text", body: "e2" }, "m.relates_to": { rel_type: "replace", event_id: "$t" } },
      event_id: "$e2",
      ts: 3,
    });
    const map = latestEdits([target, e1, e2]);
    expect(map.get("$t")!.getId()).toBe("$e2");
    expect((map.get("$t")!.getContent()["m.new_content"] as { body: string }).body).toBe("e2");
  });
});

describe("aggregateReactions", () => {
  it("counts and flags mine", () => {
    const target = makeEvent({ type: "m.room.message", sender: BOB, content: { msgtype: "m.text", body: "x" }, event_id: "$t" });
    const r1 = makeEvent({ type: "m.reaction", sender: BOB, content: { "m.relates_to": { rel_type: "annotation", event_id: "$t", key: "👍" }, value: "👍" } });
    const r2 = makeEvent({ type: "m.reaction", sender: ALICE, content: { "m.relates_to": { rel_type: "annotation", event_id: "$t", key: "👍" }, value: "👍" } });
    const agg = aggregateReactions([target, r1, r2], ALICE);
    const list = agg.get("$t")!;
    expect(list.length).toBe(1);
    expect(list[0]!.count).toBe(2);
    expect(list[0]!.mine).toBe(true);
  });
});

describe("replyTargetId", () => {
  it("reads m.in_reply_to", () => {
    const ev = makeEvent({
      type: "m.room.message",
      sender: ALICE,
      content: { msgtype: "m.text", body: "x", "m.relates_to": { "m.in_reply_to": { event_id: "$t" } } },
    });
    expect(replyTargetId(ev)).toBe("$t");
  });
});

describe("mentions", () => {
  const roomStub = {
    getJoinedMembers: () => ({
      [BOB]: { userId: BOB },
      [ALICE]: { userId: ALICE },
    }),
    currentState: {
      getStateEvents: (type: string) =>
        type === "m.room.power_levels"
          ? {
              getContent: () => ({
                users: { [ALICE]: 100, [BOB]: 0 },
                users_default: 0,
                notifications: { room: 100 },
              }),
            }
          : null,
    },
  } as unknown as Room;

  it("extracts full and local-part mentions", () => {
    const m = detectMentions("hey @bob:hs.test and @carol:other.test !", roomStub, ALICE);
    expect(m.userIds).toContain(BOB);
    expect(m.userIds).not.toContain("@carol:other.test");
  });

  it("localpart matches members on own domain", () => {
    const m = detectMentions("yo @bob", roomStub, ALICE);
    expect(m.userIds).toEqual([BOB]);
  });

  it("detects @room flag", () => {
    expect(detectMentions("@room deploy!", roomStub, ALICE).atRoom).toBe(true);
  });

  it("@room power guard", () => {
    expect(canNotifyRoom(null, roomStub, ALICE)).toBe(true);
    expect(canNotifyRoom(null, roomStub, BOB)).toBe(false);
  });
});

/**
 * W5b T1 — pure space-tree rules (no client). Mirrors Element + spec 1.11:
 * order→ts→roomId sorting, one-level nesting, DM exclusion, reprised
 * (via-less) and unknown children skipped, cycles cannot recurse.
 */
import { describe, expect, it } from "vitest";
import type { RoomSummary } from "@linnet/core";
import {
  addableRooms,
  dmsWithMembers,
  favouriteRooms,
  homeRooms,
  isDirectChild,
  orderChildRefs,
  spaceEntries,
  spacesForRail,
} from "./tree.js";

function room(roomId: string, over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId,
    name: roomId,
    isDM: false,
    unread: 0,
    invite: false,
    isSpace: false,
    membership: "join",
    e2ee: false,
    spaceChildren: [],
    memberCount: 0,
    favourite: false,
    ...over,
  };
}

const ref = (roomId: string, ts: number, order?: string) => ({ roomId, ts, ...(order ? { order } : {}) });

describe("orderChildRefs (T1)", () => {
  it("sorts order first, then ts, then roomId", () => {
    const out = orderChildRefs([
      ref("!b:h.t", 5),
      ref("!a:h.t", 9),
      ref("!a:h.t", 9),
      ref("!c:h.t", 1, "b"),
      ref("!d:h.t", 2, "a.1"),
    ]);
    // ordered children (lexicographic) come before unordered
    expect(out.map((r) => r.roomId)).toEqual(["!d:h.t", "!c:h.t", "!b:h.t", "!a:h.t", "!a:h.t"]);
  });

  it("ties on order fall back to ts ascending", () => {
    const out = orderChildRefs([ref("!x:h.t", 7, "a"), ref("!y:h.t", 3, "a")]);
    expect(out.map((r) => r.roomId)).toEqual(["!y:h.t", "!x:h.t"]);
  });
});

describe("rail + home splits", () => {
  const rooms = [
    room("!sp-work:h.t", { isSpace: true, name: "Work" }),
    room("!sp-family:h.t", { isSpace: true, name: "Family" }),
    room("!dev:h.t", { name: "dev" }),
    room("!dm:h.t", { name: "Mel", isDM: true }),
  ];
  it("S1: rail spaces are name-sorted, home is separate", () => {
    expect(spacesForRail(rooms).map((r) => r.name)).toEqual(["Family", "Work"]);
  });
  it("S8: home lists every non-space room; spaces never appear as rows", () => {
    expect(homeRooms(rooms).map((r) => r.roomId)).toEqual(["!dev:h.t", "!dm:h.t"]);
  });
});

describe("spaceEntries", () => {
  const rooms = [
    room("!sp:h.t", {
      isSpace: true,
      name: "Work",
      spaceChildren: [ref("!team:h.t", 1), ref("!nested:h.t", 2), ref("!gone:h.t", 3), ref("!dm:h.t", 4)],
    }),
    room("!nested:h.t", { isSpace: true, name: "Nested", spaceChildren: [ref("!deep:h.t", 10), ref("!sp:h.t", 11)] }),
    room("!team:h.t"),
    room("!deep:h.t"),
    room("!dm:h.t", { isDM: true }),
  ];

  it("S2: direct room children render in order", () => {
    const e = spaceEntries("!sp:h.t", rooms);
    expect(e[0]).toEqual({ kind: "room", room: expect.objectContaining({ roomId: "!team:h.t" }), direct: true });
  });

  it("S7: DM children are excluded from space sections", () => {
    expect(spaceEntries("!sp:h.t", rooms).some((x) => x.kind === "room" && x.room.roomId === "!dm:h.t")).toBe(false);
  });

  it("unknown/removed children are skipped (S5 reprised links)", () => {
    expect(spaceEntries("!sp:h.t", rooms).some((x) => x.kind === "room" && x.room.roomId === "!gone:h.t")).toBe(false);
  });

  it("S3: nested spaces fold ONE level with their room children", () => {
    const e = spaceEntries("!sp:h.t", rooms);
    const nested = e.find((x) => x.kind === "nested");
    expect(nested?.kind).toBe("nested");
    if (nested?.kind === "nested") {
      expect(nested.space.roomId).toBe("!nested:h.t");
      expect(nested.rooms.map((r) => r.roomId)).toEqual(["!deep:h.t"]);
    }
  });

  it("cycles: a nested space pointing back at the ancestor contributes nothing recursive", () => {
    const e = spaceEntries("!sp:h.t", rooms);
    const nested = e.find((x) => x.kind === "nested");
    if (nested?.kind === "nested") {
      expect(nested.rooms.map((r) => r.roomId)).not.toContain("!sp:h.t");
    }
    // and rendering the nested space's own section still terminates
    expect(spaceEntries("!nested:h.t", rooms).length).toBeGreaterThanOrEqual(0);
  });

  it("space missing from the list yields no entries", () => {
    expect(spaceEntries("!nope:h.t", rooms)).toEqual([]);
  });
});

describe("addableRooms / isDirectChild (S4)", () => {
  const rooms = [
    room("!sp:h.t", { isSpace: true, spaceChildren: [ref("!team:h.t", 1)] }),
    room("!sp2:h.t", { isSpace: true }),
    room("!team:h.t"),
    room("!free:h.t", { name: "free" }),
    room("!dm:h.t", { isDM: true }),
    room("!inv:h.t", { invite: true, membership: "invite" }),
  ];
  it("lists joined plain rooms not already linked; excludes spaces/DMs/invites/self", () => {
    expect(addableRooms("!sp:h.t", rooms).map((r) => r.roomId)).toEqual(["!free:h.t"]);
  });
  it("remove affordance only for direct children", () => {
    expect(isDirectChild("!sp:h.t", "!team:h.t", rooms)).toBe(true);
    expect(isDirectChild("!sp:h.t", "!free:h.t", rooms)).toBe(false);
  });
});

// ── W14 ─ favourites + group-view DMs (pure rules) ────────────────

describe("W14 favouriteRooms", () => {
  it("keeps favourited rooms only; invites and spaces never qualify", () => {
    const rooms = [
      room("!a", { favourite: true }),
      room("!b", { favourite: false }),
      room("!i", { favourite: true, invite: true }),
      room("!s", { favourite: true, isSpace: true }),
    ];
    expect(favouriteRooms(rooms).map((r) => r.roomId)).toEqual(["!a"]);
  });

  it("preserves incoming list order", () => {
    const rooms = [room("!z", { favourite: true }), room("!a", { favourite: true })];
    expect(favouriteRooms(rooms).map((r) => r.roomId)).toEqual(["!z", "!a"]);
  });
});

describe("W14 dmsWithMembers (space view shows shared DMs)", () => {
  it("matches DMs by partner id, ignores rooms/invites/strangers", () => {
    const rooms = [
      room("!dm1", { isDM: true, dmUserId: "@bob:h" }),
      room("!dm2", { isDM: true, dmUserId: "@eve:h" }),
      room("!dm3", { isDM: true, dmUserId: "@bob:h", invite: true }),
      room("!plain", { dmUserId: "@bob:h" }),
    ];
    const got = dmsWithMembers(rooms, new Set(["@bob:h"]));
    expect(got.map((r) => r.roomId)).toEqual(["!dm1"]);
  });
});

/**
 * W5b — pure space-tree functions (T1 target). No js-sdk imports: everything
 * works off the plain RoomSummary list core emits, so ordering/nesting/
 * DM-exclusion/cycle rules are unit-testable without a client.
 *
 * Spec notes (matrix spec 1.11 §11.1 spaces):
 * - m.space.child state_key = child room id; content.via empty/missing means
 *   the link was REMOVED (core's summarize already filters those out — the
 *   "unknown child" skip here covers children pointing at left/forgotten rooms)
 * - content.order sorts lexicographically; origin_server_ts is the fallback
 * - nesting folds ONE level only (Element mirrors this)
 * - DMs are never rendered inside space sections
 */
import type { RoomSummary, SpaceChildRef } from "@linnet/core";

type Ref = Pick<SpaceChildRef, "roomId" | "ts"> & { order?: string };

/** order-first (ASCII lexicographic), then ts ascending, then roomId for a
 *  deterministic total order. Children WITHOUT order sort after children WITH. */
export function orderChildRefs<T extends Ref>(refs: readonly T[]): T[] {
  return [...refs].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined && a.order !== b.order) {
      return a.order < b.order ? -1 : 1;
    }
    if (a.order !== undefined && b.order === undefined) return -1;
    if (a.order === undefined && b.order !== undefined) return 1;
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
  });
}

/** Joined spaces for the rail, name-sorted (S1). */
export function spacesForRail(rooms: RoomSummary[]): RoomSummary[] {
  return rooms
    .filter((r) => r.isSpace)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Home list: every non-space room — spaces never double-render as rows (S8). */
export function homeRooms(rooms: RoomSummary[]): RoomSummary[] {
  return rooms.filter((r) => !r.isSpace);
}

export type SpaceEntry =
  | { kind: "room"; room: RoomSummary; direct: true }
  | { kind: "nested"; space: RoomSummary; rooms: RoomSummary[] };

/** Ordered entries for one space's section (S2, S7): direct room children,
 *  nested spaces folded one level (their room children listed beneath),
 *  DMs excluded, removed/unknown children skipped, cycles cannot recurse. */
export function spaceEntries(spaceId: string, rooms: RoomSummary[]): SpaceEntry[] {
  const byId = new Map(rooms.map((r) => [r.roomId, r]));
  const space = byId.get(spaceId);
  if (!space) return [];
  const out: SpaceEntry[] = [];
  for (const ref of orderChildRefs(space.spaceChildren)) {
    const child = byId.get(ref.roomId);
    if (!child) continue; // removed child, or left/not-shared room
    if (child.isDM) continue; // S7 — DMs never live in space sections
    if (child.isSpace) {
      if (child.roomId === spaceId) continue; // self-cycle
      // fold exactly one level; skip spaces pointing back at the ancestor (cycle)
      const nested = orderChildRefs(child.spaceChildren)
        .map((g) => byId.get(g.roomId))
        .filter((r): r is RoomSummary => Boolean(r) && !r!.isDM && !r!.isSpace && r!.roomId !== spaceId);
      out.push({ kind: "nested", space: child, rooms: nested });
    } else {
      out.push({ kind: "room", room: child, direct: true });
    }
  }
  return out;
}

/** Candidate rooms for "add existing room" (S4): joined plain rooms not
 *  already linked into the space, excluding the space itself and DMs. */
export function addableRooms(spaceId: string, rooms: RoomSummary[]): RoomSummary[] {
  const space = rooms.find((r) => r.roomId === spaceId);
  const linked = new Set((space?.spaceChildren ?? []).map((c) => c.roomId));
  return rooms.filter((r) => !r.isSpace && !r.isDM && !r.invite && r.roomId !== spaceId && !linked.has(r.roomId));
}

/** W14 item 6: favourited non-space rooms (invites keep the Rooms list UI). */
export function favouriteRooms(rooms: RoomSummary[]): RoomSummary[] {
  return rooms.filter((r) => r.favourite && !r.isSpace && !r.invite);
}

/** W14 item 5: DMs whose partner is in the given member set — a group view
 *  shows the people you share, so their DM threads land here. */
export function dmsWithMembers(rooms: RoomSummary[], memberIds: Set<string>): RoomSummary[] {
  return rooms.filter((r) => r.isDM && !r.invite && Boolean(r.dmUserId) && memberIds.has(r.dmUserId!));
}

/** True when roomId is currently a DIRECT active child of spaceId (drives the
 *  per-row "remove from space" affordance — folded grandchildren belong to
 *  their nested space, not this one). */
export function isDirectChild(spaceId: string, roomId: string, rooms: RoomSummary[]): boolean {
  const space = rooms.find((r) => r.roomId === spaceId);
  return Boolean(space?.spaceChildren.some((c) => c.roomId === roomId));
}

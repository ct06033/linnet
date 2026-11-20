/**
 * P1 room-list sorting modes (PRD: "Room list sorting modes"). The MASTER
 * list is sorted once in App; every section helper preserves that order.
 * Prefs live in localStorage (same seam as panes/appearance).
 */
import type { RoomSummary } from "@linnet/core";

export type SortMode = "recent" | "az" | "unread";
const LS_KEY = "linnet.roomsort.v1";

export function loadSortMode(): SortMode {
  try {
    const v = globalThis.localStorage?.getItem(LS_KEY);
    return v === "az" || v === "unread" || v === "recent" ? v : "recent";
  } catch {
    return "recent";
  }
}

export function saveSortMode(m: SortMode): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, m);
  } catch {
    /* private mode — in-memory only */
  }
}

export function sortRooms(rooms: RoomSummary[], mode: SortMode): RoomSummary[] {
  const out = [...rooms];
  if (mode === "az") out.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === "unread")
    out.sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.lastTs - a.lastTs || a.name.localeCompare(b.name));
  else out.sort((a, b) => b.lastTs - a.lastTs || a.name.localeCompare(b.name));
  return out;
}

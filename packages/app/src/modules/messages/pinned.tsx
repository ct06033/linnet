/**
 * P1 message pinning (PRD §7 "Message pinning + pinned list").
 * Standard Matrix shape: one m.room.pinned_events state event per room,
 * content.pinned = array of event ids (we store newest-first). Element and
 * other spec clients see the same list — full interop, no custom event type.
 */
import { useEffect, useState } from "react";
import { EventType, MatrixEvent, Method, type Room } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import { bodyOf, displayNameOf, kindOf } from "./model.js";

export const PINNED_STATE_TYPE = EventType.RoomPinnedEvents;

/** Current pinned event ids (order = state array order, newest first). */
export function pinnedIds(room: Room | null | undefined): string[] {
  const content = room
    ?.currentState.getStateEvents(PINNED_STATE_TYPE, "")
    ?.getContent() as { pinned?: unknown } | undefined;
  return Array.isArray(content?.pinned)
    ? (content!.pinned as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
}

/** Add (front) or remove an event id; single read-modify-write state PUT. */
export async function togglePinned(
  client: MatrixClient,
  room: Room | null | undefined,
  roomId: string,
  eventId: string,
): Promise<void> {
  const cur = pinnedIds(room);
  const next = cur.includes(eventId) ? cur.filter((i) => i !== eventId) : [eventId, ...cur];
  await client.sendStateEvent(roomId, PINNED_STATE_TYPE, { pinned: next }, "");
}

/** GET /rooms/{}/event/{} — pinned ids outside the loaded timeline.
 *  js-sdk 45: client.request is GONE, use http.authedRequest (W15 lesson). */
async function fetchEventById(client: MatrixClient, roomId: string, id: string): Promise<MatrixEvent | null> {
  try {
    const path = `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(id)}`;
    const raw = await client.http.authedRequest<Record<string, unknown>>(Method.Get, path);
    return raw && typeof raw === "object" && raw["event_id"] ? new MatrixEvent(raw) : null;
  } catch {
    return null; // redacted, pruned, or no permission — the row degrades
  }
}

export interface PinnedPanelProps {
  client: MatrixClient;
  room: Room;
  onClose: () => void;
  onUnpin: (eventId: string) => void;
  onJump: (eventId: string) => void;
}

export function PinnedPanel({ client, room, onClose, onUnpin, onJump }: PinnedPanelProps): JSX.Element {
  const ids = pinnedIds(room);
  // Timeline-resolvable rows render immediately; ids the client hasn't
  // synced get fetched once and cached per panel session.
  const [fetched, setFetched] = useState<Record<string, MatrixEvent | null>>({});
  useEffect(() => {
    let dead = false;
    for (const id of ids) {
      if (room.findEventById(id) || id in fetched) continue;
      void fetchEventById(client, room.roomId, id).then((ev) => {
        if (!dead) setFetched((f) => ({ ...f, [id]: ev }));
      });
    }
    return () => {
      dead = true;
    };
  }, [ids.join(","), client, room]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = (id: string): MatrixEvent | null | undefined => room.findEventById(id) ?? fetched[id];

  return (
    <aside className="pinned-panel" data-testid="pinned-panel" aria-label="Pinned messages">
      <div className="settings-head">
        <span>📌 Pinned ({ids.length})</span>
        <button aria-label="Close pinned list" onClick={onClose}>
          ✕
        </button>
      </div>
      {ids.length === 0 && <p className="muted">Nothing pinned yet — use 📌 on any message.</p>}
      {ids.map((id) => {
        const ev = resolve(id);
        const body = ev ? bodyOf(ev) : ev === null ? "Message unavailable (deleted or pruned)." : "loading…";
        const sender = ev?.getSender();
        const ts = ev?.getTs();
        return (
          <div className="pinned-row" key={id} data-testid={`pinned-row-${id}`}>
            <div className="pinned-meta">
              <strong>{sender ? displayNameOf(client, sender) : "?"}</strong>
              {ts ? <time>{new Date(ts).toLocaleString()}</time> : null}
            </div>
            <p className={`pinned-body${kindOfSafe(ev) === "text" ? "" : " non-text"}`}>{body}</p>
            <div className="pinned-actions">
              <button
                aria-label="Jump to message"
                disabled={!room.findEventById(id)}
                onClick={() => onJump(id)}
              >
                → Jump
              </button>
              <button aria-label="Unpin message" onClick={() => onUnpin(id)}>
                Unpin
              </button>
            </div>
          </div>
        );
      })}
    </aside>
  );
}

function kindOfSafe(ev: MatrixEvent | null | undefined): string {
  try {
    return ev ? kindOf(ev) : "";
  } catch {
    return "";
  }
}

/**
 * P1 jump-to-date + message search (PRD: "Jump-to-date (MSC3030), message
 * search over local index").
 *
 * Ground truth measured 2026-11-20 on Synapse 1.165 (HS-A + the stack-wide
 * default config): MSC3030 `/timestamps` is 404 and POST /search is 400
 * "Invalid search query" (no event index provider) — neither the date index
 * nor server full-text exist on any reachable server. So BOTH features run
 * client-side over the events the client actually holds:
 *   - search: scan of the live timeline (which includes every page pulled by
 *     pagination — js-sdk prepends them to the same array);
 *   - jump-to-date: backward /messages pagination until the target date is
 *     covered (bounded), then the nearest events are offered for click-jump.
 * Encrypted rooms are BETTER this way (the server index could never read them).
 * A persistent on-disk index is the separate PRD P1–P2 line (seshat-style).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Direction, EventType, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { bodyOf } from "./model.js";

export interface SearchHit {
  eventId: string;
  ts: number;
  sender: string;
  snippet: string;
}

const MAX_PAGE_FETCHES = 12;

export function matchHaystack(ev: MatrixEvent): string {
  const c = ev.getContent() as Record<string, unknown>;
  const name = typeof c["body"] === "string" ? (c["body"] as string) : "";
  const fname = (c["info"] as Record<string, unknown> | undefined)?.["m.file"] ? JSON.stringify(c["info"]) : "";
  return `${name} ${fname}`.toLowerCase();
}

/** Scan every event the client currently holds for the room. */
export function searchLoaded(room: Room | null | undefined, term: string): SearchHit[] {
  const t = term.trim().toLowerCase();
  if (!room || t.length < 2) return [];
  const out: SearchHit[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.isRedacted?.()) continue;
    const type = ev.getType();
    if (type !== EventType.RoomMessage && type !== EventType.Sticker && !type.startsWith("m.")) continue;
    if (!matchHaystack(ev).includes(t)) continue;
    const id = ev.getId();
    if (!id || ev.getSender() === undefined) continue;
    out.push({ eventId: id, ts: ev.getTs(), sender: ev.getSender()!, snippet: bodyOf(ev) });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, 50);
}

/**
 * Page the timeline back until it reaches `targetTs` (or history/token
 * budget runs out). Returns how far back coverage now reaches.
 */
export async function paginateToDate(
  client: MatrixClient,
  room: Room,
  targetTs: number,
  onProgress?: (pages: number) => void,
): Promise<{ reached: boolean; pages: number }> {
  let pages = 0;
  for (;;) {
    const events = room.getLiveTimeline().getEvents();
    const earliest = events.length ? events[0]!.getTs() : Infinity;
    if (earliest <= targetTs) return { reached: true, pages };
    if (pages >= MAX_PAGE_FETCHES) return { reached: false, pages };
    const token = room.getLiveTimeline().getPaginationToken(Direction.Backward);
    if (!token) return { reached: earliest <= targetTs, pages };
    try {
      await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true });
    } catch {
      return { reached: false, pages };
    }
    pages += 1;
    onProgress?.(pages);
  }
}

/** Nearest events to a date AFTER coverage reached it (ascending ts). */
export function eventsAround(room: Room | null | undefined, targetTs: number): SearchHit[] {
  if (!room) return [];
  const out: SearchHit[] = [];
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.getType() !== EventType.RoomMessage) continue;
    const id = ev.getId();
    if (!id) continue;
    if (ev.getTs() >= targetTs) out.push({ eventId: id, ts: ev.getTs(), sender: ev.getSender() ?? "?", snippet: bodyOf(ev) });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(0, 8);
}

export interface SearchPanelProps {
  client: MatrixClient;
  room: Room;
  onClose: () => void;
  onJump: (eventId: string) => void;
}

export function SearchPanel({ client, room, onClose, onJump }: SearchPanelProps): JSX.Element {
  const [term, setTerm] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dateMsg, setDateMsg] = useState<string | null>(null);
  const [dateHits, setDateHits] = useState<SearchHit[] | null>(null);
  const [tick, setTick] = useState(0);
  const dead = useRef(false);
  useEffect(() => () => { dead.current = true; }, []);

  // re-scan when the timeline grows (pagination, new echoes)
  useEffect(() => {
    const onTl = (_ev: MatrixEvent, rm?: Room): void => {
      if (rm?.roomId === room.roomId) setTick((t) => t + 1);
    };
    client.on(RoomEvent.Timeline, onTl);
    return () => {
      client.removeListener(RoomEvent.Timeline, onTl);
    };
  }, [client, room]);

  const hits = useMemo(() => searchLoaded(room, term), [term, room, tick]);

  async function runDateJump(): Promise<void> {
    if (!date || busy) return;
    const target = new Date(date + "T00:00:00").getTime();
    if (!Number.isFinite(target)) return;
    setBusy(true);
    setProgress(0);
    setDateMsg(null);
    const { reached, pages } = await paginateToDate(client, room, target, (p) => !dead.current && setProgress(p));
    const found = eventsAround(room, target);
    if (!dead.current) {
      setDateHits(found);
      setDateMsg(
        found.length
          ? null
          : reached
            ? "No messages on or after that date."
            : `History stopped ${pages} pages short of that date.`,
      );
      setBusy(false);
    }
  }

  return (
    <aside className="pinned-panel search-panel" data-testid="search-panel" aria-label="Search this room">
      <div className="settings-head">
        <span>🔍 Search {room.name || ""}</span>
        <button aria-label="Close search" onClick={onClose}>✕</button>
      </div>
      <input
        type="search"
        aria-label="Search messages"
        placeholder="Find text in loaded messages…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        data-testid="search-input"
      />
      {term.trim().length >= 2 && (
        <div className="search-results" data-testid="search-results">
          {hits.length === 0 && <p className="muted">Nothing in the loaded timeline{progress === null ? " — try scrolling up first." : "."}</p>}
          {hits.map((h) => (
            <button key={h.eventId} className="search-hit" data-testid={`hit-${h.eventId}`} onClick={() => onJump(h.eventId)}>
              <span className="sh-meta">{shortOf(h.sender)} · {new Date(h.ts).toLocaleString()}</span>
              <span className="sh-body">{highlight(h.snippet, term)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="search-date-row">
        <input type="date" aria-label="Jump to date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="date-input" />
        <button onClick={() => void runDateJump()} disabled={busy || !date} data-testid="date-go">
          {busy ? `loading history… ${progress ?? ""}` : "Jump to date"}
        </button>
      </div>
      {dateMsg && <p className="muted" data-testid="date-msg">{dateMsg}</p>}
      {dateHits && dateHits.length > 0 && (
        <div className="search-results" data-testid="date-results">
          {dateHits.map((h) => (
            <button key={h.eventId} className="search-hit" data-testid={`hit-${h.eventId}`} onClick={() => onJump(h.eventId)}>
              <span className="sh-meta">{shortOf(h.sender)} · {new Date(h.ts).toLocaleString()}</span>
              <span className="sh-body">{h.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

function shortOf(uid: string): string {
  return uid.split(":")[0]?.replace(/^@/, "") ?? uid;
}

function highlight(text: string, term: string): (string | JSX.Element)[] {
  const t = term.trim();
  if (!t) return [text];
  const parts: (string | JSX.Element)[] = [];
  const lower = text.toLowerCase();
  const needle = t.toLowerCase();
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) { parts.push(text.slice(i)); break; }
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark key={k++}>{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  return parts;
}

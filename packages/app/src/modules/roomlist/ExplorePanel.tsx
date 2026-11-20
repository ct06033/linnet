/**
 * P1 "explore/join public rooms" (PRD §7). Room directory via
 * client.publicRooms(); search box maps to the spec `filter` param; join is
 * the plain /join route — the room lands through the normal sync path.
 */
import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { RoomSummary } from "@linnet/core";

interface DirRoom {
  room_id: string;
  name?: string;
  topic?: string;
  num_joined_members?: number;
}

export function ExplorePanel({
  client,
  known,
  onClose,
}: {
  client: MatrixClient;
  known: Set<string>;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<DirRoom[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "empty">("loading");
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setStatus("loading");
    const t = setTimeout(() => {
      void client
        .publicRooms({ limit: 50, ...(query.trim() ? { filter: query.trim() } : {}) } as never)
        .then((res) => {
          if (dead) return;
          const chunk = ((res as { chunk?: DirRoom[] }).chunk ?? []) as DirRoom[];
          setRows(chunk);
          setStatus(chunk.length ? "idle" : "empty");
        })
        .catch(() => !dead && setStatus("error"));
    }, 250); // debounce keystrokes
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [client, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function join(id: string): Promise<void> {
    setBusyId(id);
    try {
      await client.joinRoom(id);
      setJoined((s) => new Set(s).add(id));
    } catch {
      /* surfaced below via busyId clear */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="explore-scrim" role="presentation" onClick={onClose}>
      <section className="explore-panel" role="dialog" aria-label="Explore public rooms" data-testid="explore-panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>Explore public rooms</strong>
          <button aria-label="Close explore" onClick={onClose}>✕</button>
        </header>
        <input
          type="search"
          aria-label="Search room directory"
          placeholder="Search the room directory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="explore-query"
        />
        {status === "loading" && <p className="muted">loading…</p>}
        {status === "error" && <p className="muted" data-testid="explore-error">The homeserver room directory is unavailable.</p>}
        {status === "empty" && <p className="muted" data-testid="explore-empty">No public rooms found.</p>}
        <ul className="explore-list">
          {rows.map((r) => {
            const isMine = known.has(r.room_id) || joined.has(r.room_id);
            return (
              <li key={r.room_id} data-testid={`explore-${r.room_id}`}>
                <span className="ex-name">{r.name || r.room_id}</span>
                {r.topic ? <span className="ex-topic">{r.topic}</span> : null}
                <span className="ex-meta">{r.num_joined_members ?? "?"} members</span>
                {isMine ? (
                  <span className="ex-joined">joined</span>
                ) : (
                  <button
                    onClick={() => void join(r.room_id)}
                    disabled={busyId === r.room_id}
                    aria-label={`Join ${r.name || r.room_id}`}
                  >
                    {busyId === r.room_id ? "…" : "Join"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

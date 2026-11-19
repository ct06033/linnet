/**
 * Wave-1 mock shell: spaces rail | room list (DMs separated) | timeline pane.
 * Everything here is fake data (PRD §3 pillars rendered early for feel).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ModuleRegistry, SlashCommandContribution } from "@linnet/core";
import { bootRegistry } from "./modules.js";
import { readConfig } from "./bridge.js";

interface RoomRow {
  name: string;
  unread: number;
  invite?: boolean;
}

const SPACES = ["Home", "Family", "Work", "Hobby"];
const DMS: RoomRow[] = [
  { name: "Melchior", unread: 0 },
  { name: "Shared Voyage crew", unread: 2 },
];
const ROOMS: RoomRow[] = [
  { name: "linnet-dev", unread: 7 },
  { name: "matrix-spec", unread: 0, invite: false },
  { name: "self-hosting", unread: 1 },
];

export function App(): ReactNode {
  const [registry, setRegistry] = useState<ModuleRegistry | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("Home");

  useEffect(() => {
    void readConfig(); // exercise bridge; config-driven homeserver comes W2
    bootRegistry().then(setRegistry);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo(
    () => (registry ? registry.list("slash-command") : []),
    [registry],
  );
  const filtered = commands.filter((c) => c.command.includes(query.toLowerCase()));

  return (
    <div className="shell">
      <nav className="rail" aria-label="Spaces">
        <div className="brand">
          <button className="acct" title="Switch account (multi-account, W2)">
            L
          </button>
          <strong>Linnet</strong>
        </div>
        {SPACES.map((s) => (
          <button
            key={s}
            className={`space${s === space ? " active" : ""}`}
            onClick={() => setSpace(s)}
          >
            {s}
          </button>
        ))}
      </nav>

      <aside className="roomlist" aria-label="Rooms">
        <h3>People</h3>
        {DMS.map((r) => (
          <Row key={r.name} r={r} />
        ))}
        <h3>Rooms — {space}</h3>
        {ROOMS.map((r) => (
          <Row key={r.name} r={r} />
        ))}
      </aside>

      <main className="timeline">
        <header>
          <span>linnet-dev</span>
          <button onClick={() => setPaletteOpen(true)}>Ctrl+K</button>
        </header>
        <p className="placeholder">not wired yet — wave 1 scaffold (mock shell)</p>
        <footer className="composer">composer arrives wave 4 · registry: {registry ? "up" : "booting…"}</footer>
      </main>

      {paletteOpen && (
        <div className="palette" role="dialog" aria-label="Command palette">
          <input
            autoFocus
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul>
            {filtered.map((c: SlashCommandContribution) => (
              <li key={c.command}>
                <code>{c.command}</code> — {c.description ?? "no description"}
              </li>
            ))}
            {filtered.length === 0 && <li className="empty">no matching module command</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ r }: { r: RoomRow }): ReactNode {
  return (
    <button className="row">
      <span className="name">{r.name}</span>
      {r.invite && <span className="invite">invite</span>}
      {r.unread > 0 && <span className="pill">{r.unread}</span>}
    </button>
  );
}

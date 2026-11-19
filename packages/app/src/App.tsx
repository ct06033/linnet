/**
 * Wave-2 shell: real accounts behind a Discord-calm 3-pane layout.
 * No accounts → Login. Otherwise → live room summaries of the ACTIVE account
 * (spaces rail is still scaffold — real space graph lands with W3).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccountMetadata, ModuleRegistry, RoomSummary, SlashCommandContribution } from "@linnet/core";
import { bootRegistry } from "./modules.js";
import { readConfig } from "./bridge.js";
import { getSessionManager } from "./session-context.js";
import { Login } from "./screens/Login.js";

const SPACES = ["Home", "Family", "Work", "Hobby"];

export function App(): ReactNode {
  const sm = getSessionManager();
  const [registry, setRegistry] = useState<ModuleRegistry | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("Home");
  const [phase, setPhase] = useState<"boot" | "login" | "ready">("boot");
  const [accounts, setAccounts] = useState<AccountMetadata[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [defaultHs, setDefaultHs] = useState<string | undefined>();

  useEffect(() => {
    void readConfig().then((c) => setDefaultHs(c.defaultHomeServer));
    bootRegistry().then(setRegistry);
    void (async () => {
      await sm.restore();
      const acc = await sm.listAccounts();
      setAccounts(acc);
      setActiveId(sm.activeId);
      setPhase(acc.length > 0 ? "ready" : "login");
    })().catch((err) => console.error("linnet boot failed", err));
    return sm.onRooms((accountId, rs) => {
      if (accountId === sm.activeId) setRooms(rs);
    });
  }, [sm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo(() => (registry ? registry.list("slash-command") : []), [registry]);
  const filtered = commands.filter((c) => c.command.includes(query.toLowerCase()));

  async function refreshAfterAuthChange(): Promise<void> {
    const acc = await sm.listAccounts();
    setAccounts(acc);
    setActiveId(sm.activeId);
    setPhase(acc.length > 0 ? "ready" : "login");
    if (acc.length > 0 && sm.activeId) sm.startSync(sm.activeId);
  }

  async function pickAccount(id: string): Promise<void> {
    await sm.setActive(id);
    setActiveId(id);
    setRooms([]);
    setMenuOpen(false);
  }

  async function signOut(id: string): Promise<void> {
    await sm.logout(id);
    setRooms([]);
    await refreshAfterAuthChange();
  }

  const dmRooms = rooms.filter((r) => r.isDM && !r.invite);
  const invites = rooms.filter((r) => r.invite);
  const plainRooms = rooms.filter((r) => !r.isDM && !r.invite);

  if (phase === "boot") {
    return <div className="boot">restoring sessions…</div>;
  }
  if (phase === "login") {
    return (
      <div className="login-wrap">
        <Login
          defaultHomeserver={defaultHs}
          onSignedIn={() => void refreshAfterAuthChange()}
        />
      </div>
    );
  }

  const activeName = accounts.find((a) => a.accountId === activeId)?.userId ?? "account";

  return (
    <div className="shell">
      <nav className="rail" aria-label="Spaces">
        <div className="brand">
          <button className="acct" title={activeName} onClick={() => setMenuOpen((v) => !v)}>
            {activeName.replace(/^@/, "").slice(0, 2).toUpperCase()}
          </button>
          <strong>Linnet</strong>
        </div>
        {menuOpen && (
          <div className="account-menu" role="menu">
            {accounts.map((a) => (
              <div key={a.accountId} className="menu-row">
                <button
                  role="menuitem"
                  className={a.accountId === activeId ? "active" : ""}
                  onClick={() => void pickAccount(a.accountId)}
                >
                  {a.userId}
                </button>
                <button className="danger" onClick={() => void signOut(a.accountId)}>
                  sign out
                </button>
              </div>
            ))}
            <button
              onClick={() => {
                setMenuOpen(false);
                setPhase("login");
              }}
            >
              + Add another account
            </button>
          </div>
        )}
        {SPACES.map((s) => (
          <button key={s} className={`space${s === space ? " active" : ""}`} onClick={() => setSpace(s)}>
            {s}
          </button>
        ))}
      </nav>

      <aside className="roomlist" aria-label="Rooms">
        <h3>People</h3>
        {dmRooms.length === 0 && <p className="empty">no DMs</p>}
        {dmRooms.map((r) => (
          <Row key={r.roomId} r={r} />
        ))}
        <h3>Rooms — {space}</h3>
        {invites.map((r) => (
          <Row key={r.roomId} r={r} />
        ))}
        {plainRooms.map((r) => (
          <Row key={r.roomId} r={r} />
        ))}
        {rooms.length === 0 && <p className="empty">syncing…</p>}
      </aside>

      <main className="timeline">
        <header>
          <span>{plainRooms[0]?.name ?? "linnet"}</span>
          <button onClick={() => setPaletteOpen(true)}>Ctrl+K</button>
        </header>
        <p className="placeholder">
          {rooms.length > 0
            ? "rooms live · timeline arrives wave 4 (threads + polls next)"
            : "waiting for first sync…"}
        </p>
        <footer className="composer">
          composer arrives wave 4 · registry: {registry ? "up" : "booting…"}
        </footer>
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

function Row({ r }: { r: RoomSummary }): ReactNode {
  return (
    <button className="row">
      <span className="name">{r.name}</span>
      {r.invite && <span className="invite">invite</span>}
      {r.unread > 0 && <span className="pill">{r.unread}</span>}
    </button>
  );
}

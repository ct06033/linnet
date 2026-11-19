/**
 * Wave-2 shell: real accounts behind a Discord-calm 3-pane layout.
 * No accounts → Login. Otherwise → live room summaries of the ACTIVE account
 * (spaces rail is still scaffold — real space graph lands with W3).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AccountMetadata, ModuleRegistry, RoomSummary, SlashCommandContribution } from "@linnet/core";
import { bootRegistry } from "./modules.js";
import { readConfig } from "./bridge.js";
import { getSessionManager } from "./session-context.js";
import { Login } from "./screens/Login.js";
import { RoomView } from "./modules/messages/RoomView.js";
import { SpaceRail } from "./modules/spaces/SpaceRail.js";
import { addableRooms, homeRooms, spaceEntries, spacesForRail } from "./modules/spaces/tree.js";
import { addRoomToSpace, createSpace, leaveAndMaybeForget, removeRoomFromSpace } from "./modules/spaces/actions.js";
import { NotificationEngine, makeNotifierPort } from "./modules/notify/engine.js";

export function App(): ReactNode {
  const sm = getSessionManager();
  const [registry, setRegistry] = useState<ModuleRegistry | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [phase, setPhase] = useState<"boot" | "login" | "ready">("boot");
  const [accounts, setAccounts] = useState<AccountMetadata[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [defaultHs, setDefaultHs] = useState<string | undefined>();
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);

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
    setSelectedRoom(null);
    setSpaceId(null);
    setAddOpen(false);
    setMenuOpen(false);
  }

  const clientForView = useMemo(() => {
    try {
      return sm.activeClient();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sm, activeId, phase]);

  // W6: notification engine — lives with the active client, dies on switch
  const focusedRef = useRef<string | null>(null);
  focusedRef.current = selectedRoom;
  useEffect(() => {
    if (!clientForView) return;
    const engine = new NotificationEngine(clientForView, makeNotifierPort(), {
      isFocused: (id) => focusedRef.current === id,
    });
    engine.start();
    return () => engine.stop();
  }, [clientForView]);

  async function signOut(id: string): Promise<void> {
    await sm.logout(id);
    setRooms([]);
    await refreshAfterAuthChange();
  }

  const dmRooms = rooms.filter((r) => r.isDM && !r.invite);
  const invites = rooms.filter((r) => r.invite);
  // W5b: selected space falls back to Home if left/forgotten (S8)
  const activeSpace = spaceId ? rooms.find((r) => r.roomId === spaceId && r.isSpace && !r.invite) ?? null : null;
  const activeSpaceId = activeSpace?.roomId ?? null;
  const homeList = homeRooms(rooms).filter((r) => !r.isDM && !r.invite);
  const entries = activeSpace ? spaceEntries(activeSpace.roomId, rooms) : [];
  const addable = activeSpace ? addableRooms(activeSpace.roomId, rooms) : [];

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
        <SpaceRail
          spaces={spacesForRail(rooms)}
          active={activeSpaceId}
          onSelect={(id) => {
            setSpaceId(id);
            setAddOpen(false);
          }}
          onCreate={async (name, isPublic) => {
            if (!clientForView) throw new Error("not signed in");
            const id = await createSpace(clientForView, { name, isPublic });
            setSpaceId(id);
          }}
        />
      </nav>

      <aside className="roomlist" aria-label="Rooms">
        {activeSpaceId === null ? (
          <>
            <h3>People</h3>
            {dmRooms.length === 0 && <p className="empty">no DMs</p>}
            {dmRooms.map((r) => (
              <Row key={r.roomId} r={r} selected={selectedRoom === r.roomId} onSelect={setSelectedRoom} />
            ))}
            <h3>Rooms</h3>
            {invites.map((r) => (
              <Row
                key={r.roomId}
                r={r}
                selected={selectedRoom === r.roomId}
                onSelect={setSelectedRoom}
                onJoin={
                  clientForView
                    ? () => {
                        void clientForView.joinRoom(r.roomId).catch(() => undefined);
                      }
                    : undefined
                }
                onDecline={
                  clientForView
                    ? () => void leaveAndMaybeForget(clientForView, r.roomId, true).catch(() => undefined)
                    : undefined
                }
              />
            ))}
            {homeList.map((r) => (
              <Row key={r.roomId} r={r} selected={selectedRoom === r.roomId} onSelect={setSelectedRoom} />
            ))}
            {rooms.length === 0 && <p className="empty">syncing…</p>}
          </>
        ) : (
          <>
            <div className="space-head">
              <h3>{activeSpace?.name}</h3>
              <button aria-label="Add room to space" onClick={() => setAddOpen((v) => !v)}>
                + Room
              </button>
            </div>
            {addOpen && (
              <div className="dialog" role="dialog" aria-label="Add existing room">
                {addable.length === 0 && <p className="empty">no rooms to add</p>}
                {addable.map((r) => (
                  <button
                    key={r.roomId}
                    onClick={() => {
                      if (clientForView && activeSpace) void addRoomToSpace(clientForView, activeSpace.roomId, r.roomId);
                      setAddOpen(false);
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
            {entries.map((e) =>
              e.kind === "room" ? (
                <Row
                  key={e.room.roomId}
                  r={e.room}
                  selected={selectedRoom === e.room.roomId}
                  onSelect={setSelectedRoom}
                  onRemove={
                    clientForView && activeSpace
                      ? () => void removeRoomFromSpace(clientForView, activeSpace.roomId, e.room.roomId)
                      : undefined
                  }
                />
              ) : (
                <div key={e.space.roomId} className="nested-space">
                  <h4>{e.space.name}</h4>
                  {e.rooms.map((r) => (
                    <Row
                      key={r.roomId}
                      r={r}
                      selected={selectedRoom === r.roomId}
                      onSelect={setSelectedRoom}
                    />
                  ))}
                </div>
              ),
            )}
            {entries.length === 0 && !addOpen && (
              <p className="empty">
                This space is empty — <button onClick={() => setAddOpen(true)}>add rooms</button>
              </p>
            )}
          </>
        )}
      </aside>

      <main className="timeline">
        {selectedRoom && clientForView ? (
          <RoomView client={clientForView} roomId={selectedRoom} registry={registry} />
        ) : (
          <>
            <header>
              <span>{homeList[0]?.name ?? dmRooms[0]?.name ?? "linnet"}</span>
              <button onClick={() => setPaletteOpen(true)}>Ctrl+K</button>
            </header>
            <p className="placeholder">
              {rooms.length > 0
                ? "pick a room — timeline is live"
                : "waiting for first sync…"}
            </p>
            <footer className="composer">composer arrives wave 4 · registry: {registry ? "up" : "booting…"}</footer>
          </>
        )}
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

function Row({
  r,
  selected,
  onSelect,
  onRemove,
  onJoin,
  onDecline,
}: {
  r: RoomSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove?: () => void;
  onJoin?: () => void;
  onDecline?: () => void;
}): ReactNode {
  return (
    <button className={`row${selected ? " selected" : ""}`} onClick={() => onSelect(r.roomId)}>
      <span className="name">{r.name}</span>
      {r.invite && <span className="invite">invite</span>}
      {r.unread > 0 && <span className="pill">{r.unread}</span>}
      {onJoin && (
        <span
          role="button"
          className="row-join"
          aria-label={`Join ${r.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onJoin();
          }}
        >
          Join
        </span>
      )}
      {onDecline && (
        <span
          role="button"
          className="row-decline"
          aria-label={`Decline ${r.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDecline();
          }}
        >
          ✕
        </span>
      )}
      {onRemove && (
        <span
          role="button"
          className="row-x"
          aria-label={`Remove ${r.name} from space`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </span>
      )}
    </button>
  );
}

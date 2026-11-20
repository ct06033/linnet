/**
 * Wave-2 shell: real accounts behind a Discord-calm 3-pane layout.
 * No accounts → Login. Otherwise → live room summaries of the ACTIVE account
 * (spaces rail is still scaffold — real space graph lands with W3).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AccountMetadata, ModuleRegistry, RoomSummary, SlashCommandContribution, SyncStatus } from "@linnet/core";
import { bootRegistry } from "./modules.js";
import { readConfig } from "./bridge.js";
import { getSessionManager } from "./session-context.js";
import { Login } from "./screens/Login.js";
import { RoomView } from "./modules/messages/RoomView.js";
import { SpaceRail } from "./modules/spaces/SpaceRail.js";
import { addRoomToSpace, createRoom, createSpace, leaveAndMaybeForget, removeRoomFromSpace } from "./modules/spaces/actions.js";
import { JoinRoomDialog, NewRoomDialog, NewSpaceDialog } from "./modules/dialogs.js";
import { addableRooms, homeRooms, isDirectChild, spaceEntries, spacesForRail } from "./modules/spaces/tree.js";
import { NotificationEngine, makeNotifierPort } from "./modules/notify/engine.js";
import { CallBanner } from "./modules/call/CallUi.js";
import { ACCENTS, DENSITIES, loadAppearance, mountAppearance, type Appearance } from "./modules/settings/appearance.js";
import { useClickAway, useModalA11y } from "./modules/a11y.js";

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
  // W12a: first-sync errors must SURFACE instead of hanging on "waiting…"
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // W12 item 8: room-row context menu (leave/decline/remove live ONLY here)
  const [rowMenu, setRowMenu] = useState<{ roomId: string; x: number; y: number } | null>(null);
  // W12 item 12: unified bottom-of-rail add control
  const [railAddOpen, setRailAddOpen] = useState(false);
  const [railDialog, setRailDialog] = useState<"space" | "room" | "join" | null>(null);
  const [defaultHs, setDefaultHs] = useState<string | undefined>();
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  // W8 theming: applied to <html> at boot; live switchable from the account menu
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const applyAppearance = useRef<((a: Appearance) => void) | null>(null);
  // W8 a11y: modal focus management refs (palette + add-room dialog)
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const addDialogRef = useRef<HTMLDivElement | null>(null);
  // W12 item 2: click-away (pointerdown outside) dismissal
  const acctZoneRef = useRef<HTMLDivElement | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const railAddRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(paletteRef, () => setPaletteOpen(false), paletteOpen);
  useModalA11y(addDialogRef, () => setAddOpen(false), addOpen);
  useClickAway(acctZoneRef, () => setMenuOpen(false), menuOpen);
  useClickAway(ctxMenuRef, () => setRowMenu(null), rowMenu !== null);
  useClickAway(paletteRef, () => setPaletteOpen(false), paletteOpen);
  useClickAway(railAddRef, () => setRailAddOpen(false), railAddOpen);
  useEffect(() => {
    applyAppearance.current = mountAppearance();
  }, []);
  function switchAppearance(next: Appearance): void {
    setAppearance(next);
    applyAppearance.current?.(next);
  }

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
    const offRooms = sm.onRooms((accountId, rs) => {
      if (accountId !== sm.activeId) return;
      setRooms(rs);
      // W9: dock/taskbar unread count (no-op off Electron)
      const total = rs.reduce((n, r) => n + (r.membership === "join" ? r.unread : 0), 0);
      void window.linnet?.setBadge?.(total);
    });
    const offStatus = sm.onSyncStatus((accountId, st) => {
      if (accountId === sm.activeId) setSyncStatus(st);
    });
    return () => {
      offRooms();
      offStatus();
    };
  }, [sm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
        setMenuOpen(false);
        setRowMenu(null);
        setRailAddOpen(false);
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
    setSyncStatus(null);
    setSelectedRoom(null);
    setSpaceId(null);
    setAddOpen(false);
    setMenuOpen(false);
    setRowMenu(null);
  }

  // W12 item 8: single entry point for the row context menu (⋯ button or right-click)
  function openRowMenu(roomId: string, x: number, y: number): void {
    const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
    const vh = typeof window !== "undefined" ? window.innerHeight : 768;
    setRowMenu({ roomId, x: Math.max(4, Math.min(x, vw - 216)), y: Math.max(4, Math.min(y, vh - 170)) });
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
      <a className="skip-link" href="#linnet-main">Skip to conversation</a>
      <nav className="rail" aria-label="Spaces">
        <div className="acct-zone" ref={acctZoneRef}>
          <div className="brand">
            <button className="acct" aria-label="Account menu" title={activeName} onClick={() => setMenuOpen((v) => !v)}>
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
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setPhase("login");
              }}
            >
              + Add another account
            </button>
            <div className="appearance-row" role="group" aria-label="Theme">
              <span className="lbl">Theme</span>
              {(["system", "light", "dark"] as const).map((m) => (
                <button
                  key={m}
                  aria-pressed={appearance.mode === m}
                  onClick={() => switchAppearance({ ...appearance, mode: m })}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="appearance-row" role="group" aria-label="Display density">
              <span className="lbl">Density</span>
              {DENSITIES.map((d) => (
                <button
                  key={d.id}
                  aria-pressed={appearance.density === d.id}
                  data-density-option={d.id}
                  onClick={() => switchAppearance({ ...appearance, density: d.id })}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <div className="appearance-row" role="group" aria-label="Accent color">
              <span className="lbl">Accent</span>
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  className="swatch"
                  style={{ background: a.css }}
                  aria-label={a.label}
                  aria-pressed={appearance.accent === a.id}
                  onClick={() => switchAppearance({ ...appearance, accent: a.id })}
                />
              ))}
            </div>
            </div>
          )}
        </div>
        <SpaceRail
          spaces={spacesForRail(rooms)}
          active={activeSpaceId}
          onSelect={(id) => {
            setSpaceId(id);
            setAddOpen(false);
          }}
        />
        <div className="rail-bottom" ref={railAddRef}>
          {railAddOpen && (
            <div className="add-menu" role="menu" aria-label="Add space or room" data-testid="rail-add-menu">
              <button role="menuitem" onClick={() => { setRailAddOpen(false); setRailDialog("space"); }}>
                New space
              </button>
              <button role="menuitem" onClick={() => { setRailAddOpen(false); setRailDialog("room"); }}>
                New room
              </button>
              <button role="menuitem" onClick={() => { setRailAddOpen(false); setRailDialog("join"); }}>
                Discover or join room
              </button>
            </div>
          )}
          <button
            className="rail-add"
            aria-label="Add space or room"
            aria-haspopup="menu"
            aria-expanded={railAddOpen}
            onClick={() => setRailAddOpen((v) => !v)}
          >
            +
          </button>
        </div>
      </nav>

      <aside className="roomlist" aria-label="Rooms">
        {activeSpaceId === null ? (
          <>
            <h3 className="section-heading">People</h3>
            {dmRooms.length === 0 && <p className="empty">no DMs</p>}
            {dmRooms.map((r) => (
              <Row
                key={r.roomId}
                r={r}
                selected={selectedRoom === r.roomId}
                onSelect={setSelectedRoom}
                onOpenMenu={openRowMenu}
              />
            ))}
            <h3 className="section-heading">Rooms</h3>
            {invites.map((r) => (
              <Row
                key={r.roomId}
                r={r}
                selected={selectedRoom === r.roomId}
                onSelect={setSelectedRoom}
                onOpenMenu={openRowMenu}
                onJoin={
                  clientForView
                    ? () => {
                        void clientForView.joinRoom(r.roomId).catch(() => undefined);
                      }
                    : undefined
                }
              />
            ))}
            {homeList.map((r) => (
              <Row
                key={r.roomId}
                r={r}
                selected={selectedRoom === r.roomId}
                onSelect={setSelectedRoom}
                onOpenMenu={openRowMenu}
              />
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
              <div
                className="dialog-scrim"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setAddOpen(false);
                }}
              >
                <div className="dialog" role="dialog" aria-modal="true" aria-label="Add existing room" ref={addDialogRef}>
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
              </div>
            )}
            {entries.map((e) =>
              e.kind === "room" ? (
                <Row
                  key={e.room.roomId}
                  r={e.room}
                  selected={selectedRoom === e.room.roomId}
                  onSelect={setSelectedRoom}
                  onOpenMenu={openRowMenu}
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
                      onOpenMenu={openRowMenu}
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

      <main className="timeline" id="linnet-main">
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
                : syncStatus?.phase === "error"
                  ? (
                      <>
                        {syncStatus.fatal
                          ? `sync failed: ${syncStatus.message} — your session was rejected, sign in again (account menu)`
                          : `sync problem: ${syncStatus.message} — retrying…`}{" "}
                        {!syncStatus.fatal && (
                          <button onClick={() => sm.retrySync()}>retry now</button>
                        )}
                      </>
                    )
                  : "waiting for first sync…"}
            </p>
            <footer className="composer">composer arrives wave 4 · registry: {registry ? "up" : "booting…"}</footer>
          </>
        )}
      </main>

      <CallBanner client={clientForView} />
      {rowMenu &&
        (() => {
          const target = rooms.find((r) => r.roomId === rowMenu.roomId);
          if (!target) return null;
          const close = (): void => setRowMenu(null);
          const canRemoveFromSpace =
            activeSpace !== null && !target.invite && isDirectChild(activeSpace.roomId, target.roomId, rooms);
          return (
            <div
              className="room-ctx-menu"
              role="menu"
              aria-label={`Actions for ${target.name}`}
              data-testid="room-ctx-menu"
              ref={ctxMenuRef}
              style={{ left: rowMenu.x, top: rowMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              {target.invite ? (
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      void clientForView?.joinRoom(target.roomId).catch(() => undefined);
                      close();
                    }}
                  >
                    Accept invite
                  </button>
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      if (clientForView) void leaveAndMaybeForget(clientForView, target.roomId, true).catch(() => undefined);
                      close();
                    }}
                  >
                    Decline invite
                  </button>
                </>
              ) : (
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    if (clientForView) void leaveAndMaybeForget(clientForView, target.roomId, target.isDM).catch(() => undefined);
                    close();
                  }}
                >
                  {target.isDM ? "Leave & forget DM" : "Leave room"}
                </button>
              )}
              {canRemoveFromSpace && activeSpace && (
                <button
                  role="menuitem"
                  onClick={() => {
                    if (clientForView) void removeRoomFromSpace(clientForView, activeSpace.roomId, target.roomId);
                    close();
                  }}
                >
                  Remove from space
                </button>
              )}
            </div>
          );
        })()}
      {paletteOpen && (
        <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={paletteRef}>
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
      {railDialog === "space" && clientForView && (
        <NewSpaceDialog
          onClose={() => setRailDialog(null)}
          onSubmit={async (name, isPublic, encrypt) => {
            const id = await createSpace(clientForView, { name, isPublic, encrypt });
            setSpaceId(id);
          }}
        />
      )}
      {railDialog === "room" && clientForView && (
        <NewRoomDialog
          onClose={() => setRailDialog(null)}
          onSubmit={async (name, isPublic, encrypt) => {
            const id = await createRoom(clientForView, { name, isPublic, encrypt });
            setSelectedRoom(id);
          }}
        />
      )}
      {railDialog === "join" && clientForView && (
        <JoinRoomDialog
          onClose={() => setRailDialog(null)}
          onJoin={async (address) => {
            await clientForView.joinRoom(address);
          }}
        />
      )}
    </div>
  );
}

function Row({
  r,
  selected,
  onSelect,
  onOpenMenu,
  onJoin,
}: {
  r: RoomSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  /** W12 item 8: opens the row context menu (the ONLY leave/decline path now) */
  onOpenMenu: (roomId: string, x: number, y: number) => void;
  onJoin?: () => void;
}): ReactNode {
  return (
    <button
      className={`row${selected ? " selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(r.roomId)}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(r.roomId, e.clientX, e.clientY);
      }}
    >
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
      <span
        role="button"
        className="row-menu"
        aria-label={`Menu for ${r.name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onOpenMenu(r.roomId, rect.left - 150, rect.bottom + 4);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onOpenMenu(r.roomId, rect.left - 150, rect.bottom + 4);
        }}
      >
        ⋯
      </span>
    </button>
  );
}

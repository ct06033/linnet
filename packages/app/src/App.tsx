/**
 * Wave-2 shell: real accounts behind a Discord-calm 3-pane layout.
 * No accounts → Login. Otherwise → live room summaries of the ACTIVE account
 * (spaces rail is still scaffold — real space graph lands with W3).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AccountMetadata, ModuleRegistry, PresenceChoice, RoomSummary, SlashCommandContribution, SyncStatus } from "@linnet/core";
import { bootRegistry } from "./modules.js";
import { loadSortMode, saveSortMode, sortRooms, type SortMode } from "./modules/roomlist/sorts.js";
import { ExplorePanel } from "./modules/roomlist/ExplorePanel.js";
import { readConfig } from "./bridge.js";
import { getSessionManager } from "./session-context.js";
import { Login } from "./screens/Login.js";
import { RoomView } from "./modules/messages/RoomView.js";
import { SpaceRail } from "./modules/spaces/SpaceRail.js";
import { addRoomToSpace, createRoom, createSpace, leaveAndMaybeForget, removeRoomFromSpace } from "./modules/spaces/actions.js";
import { LockMark } from "./modules/security/Security.js";
import { JoinRoomDialog, NewRoomDialog, NewSpaceDialog } from "./modules/dialogs.js";
import {
  addableRooms,
  dmsWithMembers,
  favouriteRooms,
  homeRooms,
  isDirectChild,
  spaceEntries,
  spacesForRail,
} from "./modules/spaces/tree.js";
import { SectionHeader, useCollapsedSections } from "./modules/roomlist/sections.js";
import { Avatar } from "./modules/ui/avatar.js";
import { PaneGutter, usePanes } from "./modules/settings/panes.js";
import { uploadBytes } from "./modules/media/core.js";
import type { MatrixClient } from "matrix-js-sdk";
import { NotificationEngine, makeNotifierPort } from "./modules/notify/engine.js";
import { CallBanner } from "./modules/call/CallUi.js";
import { UpdateBanner, updateStatusText } from "./modules/update/UpdateBanner.js";
import { useUpdates } from "./modules/update/useUpdates.js";
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
  const [roomsRaw, setRooms] = useState<RoomSummary[]>([]);
  // P1 sorts: ONE sort of the master list; every section preserves it
  const [sortMode, setSortMode] = useState<SortMode>(() => loadSortMode());
  const rooms = useMemo(() => sortRooms(roomsRaw, sortMode), [roomsRaw, sortMode]);
  const [exploreOpen, setExploreOpen] = useState(false);
  // W12a: first-sync errors must SURFACE instead of hanging on "waiting…"
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  // P1 presence: my own state + status message (persisted per account)
  const [presencePref, setPresencePref] = useState<{ presence: PresenceChoice; statusMsg?: string } | null>(null);
  useEffect(() => {
    if (activeId) void sm?.presenceFor(activeId).then(setPresencePref).catch(() => undefined);
  }, [activeId, sm]);
  function choosePresence(presence: PresenceChoice, statusMsg?: string): void {
    const p = { presence, ...(statusMsg ? { statusMsg } : {}) };
    setPresencePref(p);
    if (activeId && sm) void sm.setPresenceFor(activeId, p).catch(() => undefined);
  }
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
  // W14 item 7: collapsible People/Rooms/Favourites/nested sections
  const { collapsed, toggle: toggleSection } = useCollapsedSections();
  // W14 item 14: resizable rail/list panels
  const { startDrag } = usePanes();
  // W18: update state mirror (null on the web build — menu row hides itself)
  const updates = useUpdates();
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

  // W14 item 11: own profile avatar (uploaded via the account menu)
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (!clientForView) return;
    const me = clientForView.getUserId();
    const u = me ? clientForView.getUser(me) : undefined;
    setMyAvatar((u as { avatarUrl?: string } | undefined)?.avatarUrl ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientForView]);
  function uploadProfileAvatar(file: File): void {
    if (!clientForView) return;
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const url = await uploadBytes(clientForView, bytes, file.type || "image/png");
      await clientForView.setAvatarUrl(url);
      setMyAvatar(url);
    })().catch((err) => console.warn("linnet: profile avatar upload failed", err));
  }
  function removeProfileAvatar(): void {
    void clientForView
      ?.setAvatarUrl("")
      .then(() => setMyAvatar(null))
      .catch(() => undefined);
  }

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
  // W14 item 6: favourites show on EVERY view, always at the top
  const favList = favouriteRooms(rooms);
  // W14 item 5: a group view also carries the DMs you share with its people
  const spaceDms = useMemo(() => {
    if (!clientForView || !activeSpace) return [] as RoomSummary[];
    const memberIds = new Set<string>();
    const scope = [activeSpace.roomId];
    for (const e of spaceEntries(activeSpace.roomId, rooms)) {
      if (e.kind === "room") scope.push(e.room.roomId);
      else {
        scope.push(e.space.roomId);
        for (const r of e.rooms) scope.push(r.roomId);
      }
    }
    for (const rid of scope) {
      for (const m of clientForView.getRoom(rid)?.getJoinedMembers() ?? []) memberIds.add(m.userId);
    }
    return dmsWithMembers(rooms, memberIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientForView, activeSpace?.roomId, rooms]);
  // W14 item 6: optimistic flip lands via SessionManager.setFavourite's refresh
  function toggleFav(roomId: string, next: boolean): void {
    void sm.setFavourite(roomId, next).catch((err) => console.warn("linnet: favourite failed", err));
  }

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
  const rowProps = {
    client: clientForView,
    selectedRoom,
    onSelect: setSelectedRoom,
    onOpenMenu: openRowMenu,
    onFavourite: toggleFav,
  } as const;
  const favBlock =
    favList.length > 0 ? (
      <>
        <SectionHeader id="fav" label="Favourites" collapsed={!!collapsed.fav} onToggle={toggleSection} />
        {!collapsed.fav && favList.map((r) => <Row key={r.roomId} r={r} {...rowProps} />)}
      </>
    ) : null;

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
            {/* W14 item 11: profile avatar — sets the mxc every room's member
                event will carry (Synapse propagates profile changes). */}
            <div className="profile-row" role="group" aria-label="Profile">
              <span className="lbl">You</span>
              <Avatar client={clientForView} mxc={myAvatar} name={activeName} size={24} />
              <label className="avatar-pick" title="Upload a profile picture">
                <input
                  type="file"
                  accept="image/*"
                  aria-label="Profile avatar file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadProfileAvatar(f);
                    e.target.value = "";
                  }}
                />
                <span>Change…</span>
              </label>
              {myAvatar && (
                <button className="danger" aria-label="Remove profile avatar" onClick={removeProfileAvatar}>
                  ✕
                </button>
              )}
            </div>
            {/* P1 presence: state other clients see */}
            <div className="profile-row" role="group" aria-label="Presence">
              <span className="lbl">Status</span>
              <select
                aria-label="My presence"
                value={presencePref?.presence ?? "online"}
                onChange={(e) => choosePresence(e.target.value as PresenceChoice, presencePref?.statusMsg)}
              >
                <option value="online">Online</option>
                <option value="unavailable">Idle</option>
                <option value="offline">Invisible</option>
              </select>
              <input
                type="text"
                aria-label="Status message"
                placeholder="What's up?"
                defaultValue={presencePref?.statusMsg ?? ""}
                onBlur={(e) => choosePresence(presencePref?.presence ?? "online", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
              />
            </div>
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
            {updates && (
              <div className="appearance-row" role="group" aria-label="Updates">
                <span className="lbl">Updates</span>
                <span className="update-status" data-testid="update-status">
                  {updateStatusText(updates)}
                </span>
                <button data-testid="update-check-now" onClick={() => void updates.checkNow()}>
                  Check now
                </button>
                <label className="update-enable">
                  <input
                    type="checkbox"
                    data-testid="update-auto"
                    checked={updates.enabled}
                    onChange={(e) => void updates.setEnabled(e.target.checked)}
                  />
                  auto-check
                </label>
              </div>
            )}
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
      <PaneGutter pane="rail" startDrag={startDrag} label="Resize spaces rail" />

      <aside className="roomlist" aria-label="Rooms">
        <div className="roomlist-tools">
          <select
            aria-label="Sort rooms"
            data-testid="sort-mode"
            value={sortMode}
            onChange={(e) => {
              const m = e.target.value as SortMode;
              setSortMode(m);
              saveSortMode(m);
            }}
          >
            <option value="recent">Recent activity</option>
            <option value="az">A–Z</option>
            <option value="unread">Unread first</option>
          </select>
          <button
            className="explore-open"
            aria-label="Explore public rooms"
            data-testid="explore-open"
            onClick={() => setExploreOpen(true)}
          >
            🔎 Explore
          </button>
        </div>
        <div className="roomlist-scroll">
        {activeSpaceId === null ? (
          <>
            {favBlock}
            <SectionHeader id="people" label="People" collapsed={!!collapsed.people} onToggle={toggleSection} />
            {!collapsed.people && (
              <>
                {dmRooms.length === 0 && <p className="empty">no DMs</p>}
                {dmRooms.map((r) => (
                  <Row key={r.roomId} r={r} {...rowProps} />
                ))}
              </>
            )}
            <SectionHeader id="rooms" label="Rooms" collapsed={!!collapsed.rooms} onToggle={toggleSection} />
            {!collapsed.rooms && (
              <>
                {invites.map((r) => (
                  <Row
                    key={r.roomId}
                    r={r}
                    {...rowProps}
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
                  <Row key={r.roomId} r={r} {...rowProps} />
                ))}
              </>
            )}
            {rooms.length === 0 && (
              <p className="empty">{syncStatus?.phase === "prepared" ? "no rooms yet" : "syncing…"}</p>
            )}
          </>
        ) : (
          <>
            <div className="space-head">
              <h3>{activeSpace?.name}</h3>
            </div>
            {favBlock}
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
            <SectionHeader
              id={`sp:${activeSpaceId}`}
              label="Rooms"
              collapsed={!!collapsed[`sp:${activeSpaceId}`]}
              onToggle={toggleSection}
            />
            {!collapsed[`sp:${activeSpaceId}`] &&
              entries.map((e) =>
                e.kind === "room" ? (
                  <Row key={e.room.roomId} r={e.room} {...rowProps} />
                ) : (
                  <div key={e.space.roomId} className="nested-space">
                    <SectionHeader
                      id={`nested:${e.space.roomId}`}
                      level={4}
                      label={e.space.name}
                      collapsed={!!collapsed[`nested:${e.space.roomId}`]}
                      onToggle={toggleSection}
                    />
                    {!collapsed[`nested:${e.space.roomId}`] &&
                      e.rooms.map((r) => <Row key={r.roomId} r={r} {...rowProps} />)}
                  </div>
                ),
              )}
            {/* W14 item 5: DMs with people who share this space */}
            {spaceDms.length > 0 && (
              <>
                <SectionHeader
                  id={`dms:${activeSpaceId}`}
                  label="People"
                  collapsed={!!collapsed[`dms:${activeSpaceId}`]}
                  onToggle={toggleSection}
                />
                {!collapsed[`dms:${activeSpaceId}`] &&
                  spaceDms.map((r) => <Row key={r.roomId} r={r} {...rowProps} />)}
              </>
            )}
            {entries.length === 0 && spaceDms.length === 0 && !addOpen && (
              <p className="empty">
                This space is empty — <button onClick={() => setAddOpen(true)}>add rooms</button>
              </p>
            )}
          </>
        )}
        </div>
        {/* W14 item 2: group views pin "+ Room" to the bottom, like the rail's + */}
        {activeSpaceId !== null && (
          <div className="roomlist-bottom">
            <button
              className="roomlist-add"
              aria-haspopup="dialog"
              aria-expanded={addOpen}
              onClick={() => setAddOpen((v) => !v)}
            >
              + Room
            </button>
          </div>
        )}
      </aside>
      {exploreOpen && clientForView && (
        <ExplorePanel
          client={clientForView}
          known={new Set(rooms.map((r) => r.roomId))}
          onClose={() => setExploreOpen(false)}
        />
      )}
      <PaneGutter pane="roomlist" startDrag={startDrag} label="Resize room list" />

      <main className="timeline" id="linnet-main">
        {/* W12 restart-sync gap: sync errors must be VISIBLE even when the
            account has cached rooms — the old placeholder-only surface left
            restored sessions silently stale ("logged in but never syncs"). */}
        {syncStatus?.phase === "error" && (
          <div className="sync-banner" role="alert">
            {syncStatus.fatal
              ? `sync failed: ${syncStatus.message} — your session was rejected, sign in again (account menu)`
              : `sync problem: ${syncStatus.message} — retrying…`}{" "}
            {!syncStatus.fatal && (
              <button onClick={() => sm.retrySync()}>retry now</button>
            )}
          </div>
        )}
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
                  ? "see the sync banner above"
                  : syncStatus?.phase === "prepared"
                    ? // W12 smoke finding: a brand-new account has zero rooms — the old
                      // copy faked a permanent "sync hang". Sync IS done; act.
                      "no rooms yet — use + at the bottom left to create or join"
                    : "waiting for first sync…"}
            </p>
            <footer className="composer">composer arrives wave 4 · registry: {registry ? "up" : "booting…"}</footer>
          </>
        )}
      </main>

      <UpdateBanner />
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
              {/* W14 item 6 */}
              {!target.invite && (
                <button
                  role="menuitem"
                  onClick={() => {
                    toggleFav(target.roomId, !target.favourite);
                    close();
                  }}
                >
                  {target.favourite ? "☆ Unfavourite" : "★ Favourite"}
                </button>
              )}
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
  client,
  selectedRoom,
  onSelect,
  onOpenMenu,
  onJoin,
  onFavourite,
}: {
  r: RoomSummary;
  client: MatrixClient | null;
  selectedRoom: string | null;
  onSelect: (id: string) => void;
  /** W12 item 8: opens the row context menu (leave/decline/remove path) */
  onOpenMenu: (roomId: string, x: number, y: number) => void;
  onJoin?: () => void;
  /** W14 item 6: star toggle (standard m.favourite tag) */
  onFavourite: (roomId: string, next: boolean) => void;
}): ReactNode {
  return (
    <button
      className={`row${selectedRoom === r.roomId ? " selected" : ""}`}
      aria-current={selectedRoom === r.roomId ? "true" : undefined}
      onClick={() => onSelect(r.roomId)}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(r.roomId, e.clientX, e.clientY);
      }}
    >
      {!r.isSpace && <LockMark e2ee={r.e2ee} labeled />}
      {/* W14 item 11: real avatars in the list fall back to initials */}
      <Avatar client={client} mxc={r.avatarUrl} name={r.name} size={22} className="row-avatar" />
      <span className="name">{r.name}</span>
      {/* W14 item 13: topic ghosted beside the name */}
      {r.topic && (
        <span className="row-topic" title={r.topic}>
          {r.topic}
        </span>
      )}
      {/* W14 item 4: membership indicator for rooms (DMs are always two) */}
      {!r.isDM && !r.isSpace && r.memberCount > 0 && (
        <span className="member-count" title={`${r.memberCount} members`} aria-label={`${r.memberCount} members`}>
          👥{r.memberCount}
        </span>
      )}
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
        className={`fav-star${r.favourite ? " on" : ""}`}
        aria-label={`${r.favourite ? "Unfavourite" : "Favourite"} ${r.name}`}
        aria-pressed={r.favourite}
        onClick={(e) => {
          e.stopPropagation();
          onFavourite(r.roomId, !r.favourite);
        }}
      >
        ★
      </span>
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

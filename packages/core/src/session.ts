import {
  ClientEvent,
  EventType,
  MatrixEvent,
  NotificationCountType,
  PendingEventOrdering,
  SyncState,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import { createClientSession } from "./sdk.js";
import {
  AccountStore,
  secretKeyFor,
  type AccountMetadata,
  type KvPort,
  type SecretPort,
} from "./accounts.js";

export interface RoomSummary {
  roomId: string;
  name: string;
  isDM: boolean;
  unread: number;
  invite: boolean;
  /** W5b: m.room.create room_type === "m.space" */
  isSpace: boolean;
  /** join | invite | leave | ban (summarize drops leave/ban) */
  membership: string;
  /** W14: room has an m.room.encryption state event (padlock in the list) */
  e2ee: boolean;
  /** active m.space.child entries (state_key = child room id) */
  spaceChildren: SpaceChildRef[];
  /** W14 item 4: joined member count (0 before state sync / for invites) */
  memberCount: number;
  /** W14 item 13: m.room.topic content, undefined when unset/empty */
  topic?: string;
  /** W14 items 5/6: the other participant for DM rooms */
  dmUserId?: string;
  /** W14 item 11: m.room.avatar mxc URI (rooms; for DMs the partner's) */
  avatarUrl?: string;
  /** W14 item 6: standard Matrix "m.favourite" room tag (Element-interop) */
  favourite: boolean;
  /** P1 sorts: origin_server_ts of the newest loaded event (0 = none) */
  lastTs: number;
}

export interface SpaceChildRef {
  roomId: string;
  /** m.space.child content.order (ASCII lexicographic per spec) */
  order?: string;
  /** origin_server_ts of the child event — ordering fallback */
  ts: number;
}

export interface LoginCredentials {
  homeserverUrl: string;
  username: string;
  password: string;
}

export interface SessionManagerOptions {
  kv: KvPort;
  secrets: SecretPort;
  /** test seam (fake homeserver); undefined in prod = js-sdk uses global fetch */
  fetchFn?: typeof globalThis.fetch;
  /** Enable rust crypto (Megolm E2EE) for every session; initialized before
   *  the first startClient so to-device key sharing is processed. Default false. */
  initCrypto?: boolean;
  /** W12 restart-sync (Melchior case): a /sync request that NEVER answers
   *  (server wedged on the saved `since` position) leaves js-sdk waiting
   *  forever — no error, no banner, no recovery. If no sync response arrives
   *  this many ms after (re)starting the loop, declare it stalled: surface an
   *  error, wipe the stored sync token, and re-sync fresh. Default 75s;
   *  tests shorten it. */
  stuckSyncMs?: number;
}

interface LiveSession {
  meta: AccountMetadata;
  client: MatrixClient;
  started: boolean;
  attached: boolean;
  /** W12a: first-sync hang fix — error surfacing + restart-with-backoff state */
  retryTimer?: ReturnType<typeof setTimeout>;
  /** W12: stalled-sync watchdog timer (never-answering /sync) */
  stuckTimer?: ReturnType<typeof setTimeout>;
  /** P1 presence: user preference applied once after the first Prepared */
  presenceApplied?: boolean;
  retryAttempt: number;
  lastStatus: SyncStatus;
}

/**
 * W12a: observable sync lifecycle. "preparing" = client started, first /sync
 * not yet processed; "prepared" = first sync done (room list authoritative);
 * "error" = sync failed — `fatal` (M_UNKNOWN_TOKEN) needs a re-login,
 * otherwise SessionManager auto-restarts sync with exponential backoff.
 */
export type SyncPhase = "preparing" | "prepared" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  message?: string;
  /** true = token rejected server-side; restart would loop 401 forever */
  fatal?: boolean;
  /** ms until the next automatic restart (when one is scheduled) */
  retryInMs?: number;
}

export type PresenceChoice = "online" | "unavailable" | "offline";
export interface PresencePref {
  presence: PresenceChoice;
  statusMsg?: string;
}
const PRESENCE_KV_KEY = "linnet.presence.v1";

async function applyPresence(client: MatrixClient, pref: PresencePref): Promise<void> {
  try {
    await client.setPresence({ presence: pref.presence, status_msg: pref.statusMsg } as never);
  } catch (err) {
    console.warn("linnet: setPresence failed (homeserver presence disabled?)", err);
  }
}

/** LiveSession factory — W12a: every session starts "preparing" with retry state zeroed. */
function mkLive(meta: AccountMetadata, client: MatrixClient): LiveSession {
  return { meta, client, started: false, attached: false, retryAttempt: 0, lastStatus: { phase: "preparing" } };
}

/**
 * Crypto IndexedDB store name for ONE account. js-sdk's default prefix
 * ("matrix-js-sdk", the rust crypto wasm StoreHandle name) is a single
 * database per ORIGIN holding one account key (userId:deviceId). With the
 * default, a second login — new device after logout, or a second account on
 * this origin — opens the old device's store and OlmMachine throws
 * "the account in the store doesn't match the account in the constructor"
 * (Sean's 11-20 login failure). Keying the DB by (user, device) makes every
 * session's crypto store independent; logout deletes the DB (see deleteCryptoDb).
 */
export function cryptoDbPrefixFor(userId: string, deviceId: string): string {
  return `linnet-${userId}:${deviceId}`;
}

/**
 * initRustCrypto must run BEFORE startClient so the crypto stack processes
 * the initial /sync (to-device room keys, OTK counts). IndexedDB only where
 * it exists (Electron renderer); vitest/node gets the in-memory store.
 * W16: per-account cryptoDatabasePrefix (see cryptoDbPrefixFor).
 */
export async function ensureCrypto(client: MatrixClient): Promise<void> {
  if (client.getCrypto()) return;
  if (typeof indexedDB === "undefined") {
    await client.initRustCrypto({ useIndexedDB: false });
    return;
  }
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  const prefix = userId && deviceId ? cryptoDbPrefixFor(userId, deviceId) : undefined;
  await client.initRustCrypto(prefix ? { useIndexedDB: true, cryptoDatabasePrefix: prefix } : { useIndexedDB: true });
}

/** Best-effort delete of an account's crypto IndexedDB store (logout cleanup).
 *  Resolves on success/error; if a stale connection blocks the delete we give
 *  up after 5s rather than hang logout — the DB is per-device and harmless. */
async function deleteCryptoDb(userId: string, deviceId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      const req = indexedDB.deleteDatabase(cryptoDbPrefixFor(userId, deviceId));
      req.onsuccess = finish;
      req.onerror = finish;
    } catch {
      finish();
    }
    setTimeout(finish, 5_000);
  });
}

/**
 * Multi-account session manager (PRD Decision #5): one live js-sdk client per
 * account, isolated stores; sync runs for the ACTIVE account (background sync
 * for others is a wave-4 optimization). Tokens: SecretPort only — never in KV.
 */
export class SessionManager {
  private readonly store: AccountStore;
  private readonly live = new Map<string, LiveSession>();
  private readonly listeners = new Set<(accountId: string, rooms: RoomSummary[]) => void>();
  private readonly statusListeners = new Set<(accountId: string, status: SyncStatus) => void>();
  private readonly fetchFn?: typeof globalThis.fetch;
  private readonly stuckSyncMs: number;
  activeId: string | null = null;

  constructor(private readonly opts: SessionManagerOptions) {
    this.store = new AccountStore(opts.kv);
    this.fetchFn = opts.fetchFn;
    this.stuckSyncMs = opts.stuckSyncMs ?? 75_000;
  }

  listAccounts(): Promise<AccountMetadata[]> {
    return this.store.list();
  }

  /** Reload persisted accounts + tokens; returns accounts missing secrets (need re-login). */
  async restore(): Promise<AccountMetadata[]> {
    const orphans: AccountMetadata[] = [];
    for (const meta of await this.store.list()) {
      const token = await this.opts.secrets.load(secretKeyFor(meta.accountId));
      if (!token) {
        orphans.push(meta);
        continue;
      }
      const client = createClientSession({
        homeserverUrl: meta.homeserverUrl,
        accessToken: token,
        deviceId: meta.deviceId,
        userId: meta.userId,
        fetchFn: this.fetchFn,
      });
      if (this.opts.initCrypto) await ensureCrypto(client);
      this.live.set(meta.accountId, mkLive(meta, client));
      this.activeId ??= meta.accountId;
    }
    // W12a FIX (root cause #1 of the "waiting for first sync…" hang): restore()
    // built the clients but NOTHING ever called startSync — a cold boot with a
    // persisted account started no sync loop at all, so ClientEvent.Sync never
    // fired and the UI waited forever. Start sync for the active account here.
    if (this.activeId) this.startSync(this.activeId);
    return orphans;
  }

  async login(creds: LoginCredentials): Promise<AccountMetadata> {
    const client = createClientSession({
      homeserverUrl: creds.homeserverUrl,
      fetchFn: this.fetchFn,
    });
    const res = await client.login("m.login.password", {
      identifier: { type: "m.id.user", user: creds.username },
      password: creds.password,
      initial_device_display_name: "Linnet",
    });
    return this.finishLogin(creds.homeserverUrl, res);
  }

  /**
   * W8 SSO: GET /v3/login flow discovery. Returns which flows this homeserver
   * offers plus any advertised identity providers (name/brand/icon).
   */
  async discoverLogin(homeserverUrl: string): Promise<LoginFlows> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    const res = await fetchFn(`${trimTrailingSlash(homeserverUrl)}/_matrix/client/v3/login`);
    if (!res.ok) throw new Error(`login discovery failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      flows?: { type: string; identity_providers?: IdentityProviderInfo[] }[];
    };
    const flows = body.flows ?? [];
    const sso = flows.find((f) => f.type === "m.login.sso" || f.type === "MSC3824_LOGIN_QR");
    return {
      password: flows.some((f) => f.type === "m.login.password"),
      sso: flows.some((f) => f.type === "m.login.sso"),
      identityProviders: sso?.identity_providers ?? [],
    };
  }

  /**
   * W8 SSO (legacy UIAA redirect, PRD 6.1): ask the HS where the IdP bounce
   * starts. GET /login/sso/redirect[/:idp] — Synapse answers 302; we surface
   * the Location so the app can window.location.assign() it (web) or hand it
   * to the OS browser (Electron, W9). redirectUri must come back to us with
   * ?loginToken= appended (spec behavior of every real SSO relay).
   */
  async getSsoLoginUrl(homeserverUrl: string, redirectUri: string, idpId?: string): Promise<string> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    const seg = idpId ? `/${encodeURIComponent(idpId)}` : "";
    const url = `${trimTrailingSlash(homeserverUrl)}/_matrix/client/v3/login/sso/redirect${seg}?redirectUrl=${encodeURIComponent(redirectUri)}`;
    const res = await fetchFn(url, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) return new URL(loc, url).toString();
    }
    if (res.status === 200) {
      // some relays serve the IdP page directly; treat the URL itself as the target
      return url;
    }
    throw new Error(`SSO redirect unavailable: HTTP ${res.status}`);
  }

  /** W8 SSO: consume the ?loginToken= the IdP relay bounced back. */
  async loginWithSsoToken(homeserverUrl: string, loginToken: string): Promise<AccountMetadata> {
    const client = createClientSession({ homeserverUrl, fetchFn: this.fetchFn });
    const res = await client.login("m.login.token", {
      token: loginToken,
      initial_device_display_name: "Linnet",
    });
    return this.finishLogin(homeserverUrl, res);
  }

  private async finishLogin(
    homeserverUrl: string,
    res: { access_token?: string; user_id?: string; device_id?: string },
  ): Promise<AccountMetadata> {
    if (!res.access_token || !res.user_id || !res.device_id) {
      throw new Error("homeserver returned incomplete login response");
    }
    const accountId = `${res.user_id}|${res.device_id}`;
    const meta = await this.store.add({
      accountId,
      homeserverUrl,
      userId: res.user_id,
      deviceId: res.device_id,
      createdAt: new Date().toISOString(),
    });
    await this.opts.secrets.save(secretKeyFor(accountId), res.access_token);
    // Login-flow clients do not know their deviceId until a whoami round-trip;
    // swap for a fully-credentialed one before touching crypto (Megolm + RTC poller
    // both hard-require deviceId — js-sdk 45).
    const sessionClient = createClientSession({
      homeserverUrl,
      accessToken: res.access_token,
      deviceId: res.device_id,
      userId: res.user_id,
      fetchFn: this.fetchFn,
    });
    if (this.opts.initCrypto) await ensureCrypto(sessionClient);
    this.live.set(accountId, mkLive(meta, sessionClient));
    await this.setActive(accountId);
    return meta;
  }

  async setActive(accountId: string): Promise<void> {
    if (!this.live.has(accountId)) throw new Error(`no live session: ${accountId}`);
    this.activeId = accountId;
    const s = this.live.get(accountId)!;
    if (!s.started) this.startSync(accountId);
  }

  startSync(accountId = this.activeId ?? undefined): void {
    if (!accountId) return;
    const s = this.live.get(accountId);
    if (!s) return;
    if (!s.attached) {
      s.attached = true;
      s.client.on(ClientEvent.Sync, (state: SyncState, _old: SyncState | null, data?: unknown) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          // W12a: first sync (or a recovery sync) succeeded — retry budget resets.
          this.clearRetry(s);
          this.clearStuck(s);
          if (s.lastStatus.phase !== "prepared") {
            s.lastStatus = { phase: "prepared" };
            for (const l of this.statusListeners) l(accountId, s.lastStatus);
            // P1 presence: push the stored (or default online) presence once
            if (!s.presenceApplied) {
              s.presenceApplied = true;
              void this.presenceFor(accountId).then((p) => applyPresence(s.client, p ?? { presence: "online" }));
            }
          }
          // W14 item 6: feed js-sdk's Room.tags from the RAW sync response —
          // matrix-js-sdk 45.1.0 ignores the spec `tags: {events}` block of
          // join objects entirely (verified: no reference in src/sync.ts).
          applyTagEvents(s.client, data);
          const rooms = summarize(s.client);
          for (const l of this.listeners) l(accountId, rooms);
        } else if (state === SyncState.Error || state === SyncState.Reconnecting) {
          // W12a FIX (root cause #2 of the hang): errors used to be swallowed —
          // js-sdk emits SyncState.Error when the first /sync (or its filter/
          // pushrules bootstrap) fails, and stops the loop permanently on
          // M_UNKNOWN_TOKEN. Without handling, the UI sat on
          // "waiting for first sync…" forever. Surface it + restart w/ backoff.
          this.handleSyncError(accountId, s, state === SyncState.Reconnecting);
        }
      });
    }
    if (!s.started) {
      s.started = true;
      s.lastStatus = { phase: "preparing" };
      for (const l of this.statusListeners) l(accountId, s.lastStatus);
      // W12 (Melchior restart case): arm the stalled-sync watchdog BEFORE
      // startClient — if no sync response ever arrives (server wedged on the
      // saved since position), js-sdk waits forever without emitting Error.
      this.armStuck(accountId, s);
      // detached pending ordering → Room.getPendingEvents() works for the
      // RoomView optimistic echo; threadSupport organises MSC3440 relations
      // into Room.getThreads() (both are startClient opts in js-sdk 45 — probed)
      const start = s.client.startClient({
        initialSyncLimit: 20,
        pendingEventOrdering: PendingEventOrdering.Detached,
        threadSupport: true,
      });
      // startClient is async in js-sdk 45; a rejection here used to be an
      // unhandled promise that left the UI waiting forever.
      void Promise.resolve(start).catch((err: unknown) => {
        console.error("linnet: startClient failed", accountId, err);
        s.started = false;
        this.handleSyncError(accountId, s, false, err);
      });
    }
  }

  /** Manual "retry now" for the UI (Esc from backoff waiting). */
  retrySync(accountId = this.activeId ?? undefined): void {
    if (!accountId) return;
    const s = this.live.get(accountId);
    if (!s) return;
    this.clearRetry(s);
    s.retryAttempt = 0;
    if (s.started) {
      // force a clean loop restart (js-sdk startClient() is a no-op while the
      // client thinks it is running, even after syncApi.stop())
      try {
        s.client.stopClient();
      } catch {
        /* already stopped */
      }
      s.started = false;
    }
    this.startSync(accountId);
  }

  onSyncStatus(listener: (accountId: string, status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private handleSyncError(accountId: string, s: LiveSession, reconnecting: boolean, thrown?: unknown): void {
    this.clearStuck(s);
    const data = (s.client.getSyncStateData?.() ?? {}) as {
      error?: { errcode?: string; httpStatus?: number; statusCode?: number; message?: string };
    };
    const err = data.error ?? (thrown as { errcode?: string; httpStatus?: number; statusCode?: number; message?: string } | undefined);
    const fatal = err?.errcode === "M_UNKNOWN_TOKEN" || err?.httpStatus === 401 || err?.statusCode === 401;
    const message = String(err?.message ?? (fatal ? "session token rejected" : "sync failed"));
    console.error(`linnet: sync ${reconnecting ? "reconnecting (transient)" : "error"} (${accountId})`, fatal ? "FATAL" : "", err ?? thrown ?? "");
    if (fatal) {
      // js-sdk has already stopped the loop; restarting would 401-loop forever.
      this.clearRetry(s);
      s.lastStatus = { phase: "error", fatal: true, message };
      for (const l of this.statusListeners) l(accountId, s.lastStatus);
      return;
    }
    const retryInMs = Math.min(30_000, 1000 * 2 ** s.retryAttempt);
    s.lastStatus = { phase: "error", message, ...(reconnecting ? {} : { retryInMs }) };
    for (const l of this.statusListeners) l(accountId, s.lastStatus);
    if (!s.retryTimer) {
      s.retryAttempt += 1;
      s.retryTimer = setTimeout(() => {
        s.retryTimer = undefined;
        // only restart if still not prepared; a healthy internal js-sdk
        // retry may already have recovered the loop.
        if (s.lastStatus.phase === "error" && this.live.has(accountId)) this.retrySync(accountId);
      }, retryInMs);
    }
  }

  private clearRetry(s: LiveSession): void {
    if (s.retryTimer) {
      clearTimeout(s.retryTimer);
      s.retryTimer = undefined;
    }
    s.retryAttempt = 0;
  }

  private clearStuck(s: LiveSession): void {
    if (s.stuckTimer) {
      clearTimeout(s.stuckTimer);
      s.stuckTimer = undefined;
    }
  }

  /**
   * W12 stalled-sync watchdog (Melchior restart bug): a /sync that never
   * answers leaves the loop silently waiting — no Error event, no backoff, no
   * UI explanation. After stuckSyncMs with zero sync progress: surface an
   * error (so the banner shows), wipe the stored sync token (the saved since
   * position is what the server is wedged on), and restart the loop fresh.
   */
  private armStuck(accountId: string, s: LiveSession): void {
    this.clearStuck(s);
    s.stuckTimer = setTimeout(() => {
      s.stuckTimer = undefined;
      if (!s.started || s.lastStatus.phase === "prepared") return;
      console.error(`linnet: sync stalled (${accountId}) — no response in ${this.stuckSyncMs}ms, re-syncing without saved token`);
      s.lastStatus = { phase: "error", message: "sync stalled — homeserver never answered the sync request" };
      for (const l of this.statusListeners) l(accountId, s.lastStatus);
      try {
        const store = (s.client as unknown as {
          getStore?: () => { setSyncToken?: (t: string | null) => void } | undefined;
        }).getStore?.();
        store?.setSyncToken?.(null);
      } catch (err) {
        console.warn("linnet: could not wipe saved sync token", err);
      }
      // force the fresh restart path (started=false -> startSync re-arms +
      // startClient with no since)
      try {
        s.client.stopClient();
      } catch {
        /* already stopped */
      }
      s.started = false;
      if (this.live.has(accountId)) this.startSync(accountId);
    }, this.stuckSyncMs);
  }

  onRooms(listener: (accountId: string, rooms: RoomSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-run summarize and push the list without waiting for the next /sync
   *  echo (used after local writes like favourite toggles). */
  refreshRooms(accountId = this.activeId ?? undefined): void {
    if (!accountId) return;
    const s = this.live.get(accountId);
    if (!s) return;
    const rooms = summarize(s.client);
    for (const l of this.listeners) l(accountId, rooms);
  }

  /**
   * W14 item 6: favourite with the STANDARD Matrix room tag ("m.favourite",
   * order 0.5) — Element/Cinny/matrix-commander all see the same flag.
   * Optimistically writes Room.tags locally (js-sdk's setRoomTag is a bare
   * PUT with no local echo) and refreshes the list immediately.
   */
  async setFavourite(
    roomId: string,
    favourite: boolean,
    accountId = this.activeId ?? undefined,
  ): Promise<void> {
    if (!accountId) throw new Error("no active session");
    const s = this.live.get(accountId);
    if (!s) throw new Error(`no live session: ${accountId}`);
    if (favourite) await s.client.setRoomTag(roomId, "m.favourite", { order: 0.5 });
    else await s.client.deleteRoomTag(roomId, "m.favourite");
    const room = s.client.getRoom(roomId);
    if (room) {
      const tags = { ...(room.tags ?? {}) };
      if (favourite) tags["m.favourite"] = { order: 0.5 };
      else delete tags["m.favourite"];
      room.addTags(new MatrixEvent({ type: "m.tag", room_id: roomId, content: { tags } }));
    }
    this.refreshRooms(accountId);
  }

  /** The active account's js-sdk client (events, crypto, room APIs). Throws if none. */
  activeClient(): MatrixClient {
    const s = this.activeId ? this.live.get(this.activeId) : undefined;
    if (!s) throw new Error("no active session");
    return s.client;
  }

  /** Full local teardown for the account (server logout best-effort, secret wiped). */
  async logout(accountId: string): Promise<void> {
    const s = this.live.get(accountId);
    if (s) {
      this.clearRetry(s);
      try {
        await s.client.logout(true);
      } catch {
        /* server unreachable — local wipe still proceeds */
      }
      s.client.stopClient();
      this.live.delete(accountId);
    }
    await this.opts.secrets.remove(secretKeyFor(accountId));
    await this.store.remove(accountId);
    // W16: wipe the account's crypto IndexedDB too. stopClient() above closed
    // the OlmMachine (and its IDB connections), so the delete can proceed.
    // Without this the orphaned store is harmless to NEW logins (per-device
    // DB names) but leaks disk + stale device keys forever.
    const sep = accountId.lastIndexOf("|");
    if (sep > 0) {
      await deleteCryptoDb(accountId.slice(0, sep), accountId.slice(sep + 1));
    }
    if (this.activeId === accountId) {
      this.activeId = this.live.keys().next().value ?? null;
      if (this.activeId) this.setActive(this.activeId);
    }
  }

  /**
   * P1 presence: remember the user's choice per account and push it to the
   * homeserver. Applied once after the first Prepared sync per session (and
   * on change). Absent pref = "online" — matching every other client, so the
   * user is not invisibly offline to Element contacts. setPresence failures
   * (HS with presence disabled) are logged once and swallowed: display side
   * degrades to "unknown" dots.
   */
  async setPresenceFor(accountId: string, pref: PresencePref): Promise<void> {
    const all = await this.readPresencePrefs();
    all[accountId] = pref;
    await this.opts.kv.set(PRESENCE_KV_KEY, JSON.stringify(all));
    const s = this.live.get(accountId);
    if (s) void applyPresence(s.client, pref);
  }

  async presenceFor(accountId: string): Promise<PresencePref | null> {
    return (await this.readPresencePrefs())[accountId] ?? null;
  }

  private async readPresencePrefs(): Promise<Record<string, PresencePref>> {
    try {
      const raw = await this.opts.kv.get(PRESENCE_KV_KEY);
      return raw ? (JSON.parse(raw) as Record<string, PresencePref>) : {};
    } catch {
      return {};
    }
  }

  stopAll(): void {
    for (const s of this.live.values()) {
      this.clearRetry(s);
      this.clearStuck(s);
      s.client.stopClient();
    }
  }
}

/**
 * W14 item 6 — sync-tag bridge. The /sync join object spec shape is
 * `tags: { events: [{type:"m.tag", content:{tags:{...}}}] }`; js-sdk 45.1.0
 * never reads it (Room.tags is only fed via room.addAccountData). We apply it
 * ourselves off the raw response so favourites survive restarts and sync
 * across clients. Idempotent: addTags replaces wholesale.
 */
export function applyTagEvents(client: MatrixClient, data: unknown): void {
  const joins = (data as { rooms?: { join?: Record<string, unknown> } })?.rooms?.join;
  if (!joins) return;
  for (const [roomId, obj] of Object.entries(joins)) {
    const tagEvents = (obj as { tags?: { events?: Array<Record<string, unknown>> } })?.tags?.events;
    if (!Array.isArray(tagEvents) || tagEvents.length === 0) continue;
    const room: Room | null = client.getRoom(roomId);
    if (!room) continue;
    for (const ev of tagEvents) {
      if (ev["type"] === "m.tag") room.addTags(new MatrixEvent({ ...ev, room_id: roomId }));
    }
  }
}

function summarize(client: MatrixClient): RoomSummary[] {
  const userId = client.getUserId();
  const directEvent = (
    client.getAccountData as unknown as (k: string) => { getContent: () => unknown } | undefined
  )("m.direct");
  const directMap = (directEvent?.getContent() ?? {}) as Record<string, string[]>;
  // W21 item 11: m.direct is keyed by PARTNER id (spec + Element) — the old
  // map[ownUserId] lookup saw almost nothing, so Element DMs landed under
  // Rooms. Every room id ANYWHERE in the map is a DM.
  const directIds = new Set<string>();
  for (const list of Object.values(directMap)) {
    if (Array.isArray(list)) for (const rid of list) directIds.add(rid);
  }
  const out: RoomSummary[] = [];
  for (const room of client.getRooms()) {
    const membership = room.getMyMembership();
    // W5b: left/banned rooms must not linger in the list (settings/space leave)
    if (membership === "leave" || membership === "ban") continue;
    const spaceChildren = room.currentState
      .getStateEvents(EventType.SpaceChild)
      .map((e): SpaceChildRef | null => {
        const c = e.getContent() as { order?: string; via?: unknown };
        // spec: an m.space.child with no (or empty) "via" is a REMOVED link
        if (!Array.isArray(c?.via) || c.via.length === 0) return null;
        return {
          roomId: e.getStateKey() ?? "",
          order: typeof c.order === "string" ? c.order : undefined,
          ts: e.getTs(),
        };
      })
      .filter((c): c is SpaceChildRef => c !== null && c.roomId !== "");
    // W21 item 11: DM = listed in m.direct (any partner key), OR we were
    // invited in a DM context, OR the create event says is_direct (rooms
    // created by clients that never maintained m.direct, e.g. bot DMs).
    const isDM =
      directIds.has(room.roomId) ||
      Boolean(room.getDMInviter()) ||
      Boolean(
        (room.currentState.getStateEvents(EventType.RoomCreate, "")?.getContent() as { is_direct?: boolean } | undefined)
          ?.is_direct,
      );
    // W14 items 5/11: DM partner = the other non-left member; the inviter is
    // the fallback for a not-yet-joined DM (their member list may be stripped).
    let dmUserId: string | undefined;
    if (isDM) {
      const other = room
        .getJoinedMembers()
        .find((m) => m.userId !== userId && m.membership !== "leave");
      const inviter = room.getDMInviter();
      dmUserId = other?.userId ?? (inviter && inviter !== userId ? inviter : undefined);
    }
    const roomAvatar = room.currentState.getStateEvents("m.room.avatar", "")?.getContent()?.url as
      | string
      | undefined;
    // DM rows show the PARTNER's avatar: read raw mxc from their member event
    // (RoomMember.getAvatarUrl needs 6 args in v45 and returns http, but the
    // summary keeps mxc URIs so the app picks sizing/auth uniformly).
    const partnerAvatar = dmUserId
      ? (room.currentState.getStateEvents(EventType.RoomMember, dmUserId)?.getContent()
          ?.avatar_url as string | undefined)
      : undefined;
    out.push({
      roomId: room.roomId,
      name: room.name || room.roomId,
      isDM,
      unread: room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
      invite: membership === "invite",
      isSpace: room.isSpaceRoom(),
      membership,
      e2ee: room.hasEncryptionStateEvent(),
      spaceChildren,
      memberCount: room.getJoinedMemberCount?.() ?? 0,
      topic:
        (room.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent()?.topic as
          | string
          | undefined) || undefined,
      dmUserId,
      avatarUrl: roomAvatar ?? partnerAvatar ?? undefined,
      // W14 item 6: Room.tags is js-sdk's public per-room tag dict. js-sdk 45
      // does NOT parse the spec `tags` field of sync join objects itself (only
      // room.addAccountData with an m.tag event feeds it), so SessionManager
      // folds the raw sync data in via applyTagEvents() before summarizing.
      favourite: Boolean(room.tags?.["m.favourite"]),
      lastTs: (() => {
        const live = room.getLiveTimeline().getEvents();
        return live.length ? live[live.length - 1]!.getTs() : 0;
      })(),
    });
  }
  return out;
}

export interface IdentityProviderInfo {
  id: string;
  name: string;
  brand?: string;
  icon?: string;
}

export interface LoginFlows {
  password: boolean;
  sso: boolean;
  identityProviders: IdentityProviderInfo[];
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

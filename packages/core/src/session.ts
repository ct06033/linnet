import { ClientEvent, NotificationCountType, SyncState, type MatrixClient } from "matrix-js-sdk";
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
}

interface LiveSession {
  meta: AccountMetadata;
  client: MatrixClient;
  started: boolean;
  attached: boolean;
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
  private readonly fetchFn?: typeof globalThis.fetch;
  activeId: string | null = null;

  constructor(private readonly opts: SessionManagerOptions) {
    this.store = new AccountStore(opts.kv);
    this.fetchFn = opts.fetchFn;
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
      this.live.set(meta.accountId, {
        meta,
        client: createClientSession({
          homeserverUrl: meta.homeserverUrl,
          accessToken: token,
          deviceId: meta.deviceId,
          userId: meta.userId,
          fetchFn: this.fetchFn,
        }),
        started: false,
        attached: false,
      });
      this.activeId ??= meta.accountId;
    }
    return orphans;
  }

  async login(creds: LoginCredentials): Promise<AccountMetadata> {
    const client = createClientSession({
      homeserverUrl: creds.homeserverUrl,
      fetchFn: this.fetchFn,
    });
    const res = await client.login("m.password", {
      identifier: { type: "m.id.user", user: creds.username },
      password: creds.password,
    });
    if (!res.access_token || !res.user_id || !res.device_id) {
      throw new Error("homeserver returned incomplete login response");
    }
    const accountId = `${res.user_id}|${res.device_id}`;
    const meta = await this.store.add({
      accountId,
      homeserverUrl: creds.homeserverUrl,
      userId: res.user_id,
      deviceId: res.device_id,
      createdAt: new Date().toISOString(),
    });
    await this.opts.secrets.save(secretKeyFor(accountId), res.access_token);
    this.live.set(accountId, { meta, client, started: false, attached: false });
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
      s.client.on(ClientEvent.Sync, (state: SyncState) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          const rooms = summarize(s.client);
          for (const l of this.listeners) l(accountId, rooms);
        }
      });
    }
    if (!s.started) {
      s.started = true;
      s.client.startClient({ initialSyncLimit: 20 });
    }
  }

  onRooms(listener: (accountId: string, rooms: RoomSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Full local teardown for the account (server logout best-effort, secret wiped). */
  async logout(accountId: string): Promise<void> {
    const s = this.live.get(accountId);
    if (s) {
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
    if (this.activeId === accountId) {
      this.activeId = this.live.keys().next().value ?? null;
      if (this.activeId) this.setActive(this.activeId);
    }
  }

  stopAll(): void {
    for (const s of this.live.values()) s.client.stopClient();
  }
}

function summarize(client: MatrixClient): RoomSummary[] {
  const userId = client.getUserId();
  const directEvent = (
    client.getAccountData as unknown as (k: string) => { getContent: () => unknown } | undefined
  )("m.direct");
  const directMap = (directEvent?.getContent() ?? {}) as Record<string, string[]>;
  const direct = userId ? directMap[userId] ?? [] : [];
  return client.getRooms().map((room) => {
    const membership = room.getMyMembership();
    return {
      roomId: room.roomId,
      name: room.name || room.roomId,
      isDM: direct.includes(room.roomId) || Boolean(room.getDMInviter()),
      unread: room.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
      invite: membership === "invite",
    };
  });
}

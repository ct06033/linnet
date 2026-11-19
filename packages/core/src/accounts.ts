/**
 * Multi-account metadata + port seams (PRD §3: multi-account from day one).
 * AccountMetadata NEVER carries access tokens — tokens go through SecretPort.
 */

export interface KvPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretPort {
  save(key: string, secret: string): Promise<void>;
  load(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

export class MemoryKv implements KvPort {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

export class MemorySecrets implements SecretPort {
  private map = new Map<string, string>();
  async save(key: string, secret: string): Promise<void> {
    this.map.set(key, secret);
  }
  async load(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

export interface AccountMetadata {
  accountId: string;
  homeserverUrl: string;
  userId: string;
  deviceId?: string;
  createdAt?: string;
}

export const ACCOUNTS_KV_KEY = "linnet" + ".accounts";
export const secretKeyFor = (accountId: string): string => `token:${accountId}`;

export function isAccountMetadata(value: unknown): value is AccountMetadata {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accountId === "string" &&
    typeof v.homeserverUrl === "string" &&
    typeof v.userId === "string" &&
    (v.deviceId === undefined || typeof v.deviceId === "string") &&
    (v.createdAt === undefined || typeof v.createdAt === "string")
  );
}

/** Pick only known fields — unknown extras (e.g. a stray accessToken) cannot reach disk. */
function sanitize(meta: AccountMetadata): AccountMetadata {
  const out: AccountMetadata = {
    accountId: meta.accountId,
    homeserverUrl: meta.homeserverUrl,
    userId: meta.userId,
  };
  if (meta.deviceId !== undefined) out.deviceId = meta.deviceId;
  if (meta.createdAt !== undefined) out.createdAt = meta.createdAt;
  return out;
}

export class AccountStore {
  constructor(private readonly kv: KvPort) {}

  async list(): Promise<AccountMetadata[]> {
    const raw = await this.kv.get(ACCOUNTS_KV_KEY);
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAccountMetadata);
  }

  async add(meta: AccountMetadata): Promise<AccountMetadata> {
    const clean = sanitize(meta);
    const all = await this.list();
    if (all.some((a) => a.accountId === clean.accountId)) {
      throw new Error(`account already exists: ${clean.accountId}`);
    }
    await this.kv.set(ACCOUNTS_KV_KEY, JSON.stringify([...all, clean]));
    return clean;
  }

  async get(accountId: string): Promise<AccountMetadata | null> {
    return (await this.list()).find((a) => a.accountId === accountId) ?? null;
  }

  async update(
    accountId: string,
    patch: Partial<Pick<AccountMetadata, "deviceId" | "createdAt">>,
  ): Promise<AccountMetadata | null> {
    const all = await this.list();
    const idx = all.findIndex((a) => a.accountId === accountId);
    if (idx < 0) return null;
    const next: AccountMetadata = { ...all[idx] };
    if ("deviceId" in patch) next.deviceId = patch.deviceId;
    if ("createdAt" in patch) next.createdAt = patch.createdAt;
    all[idx] = next;
    await this.kv.set(ACCOUNTS_KV_KEY, JSON.stringify(all));
    return next;
  }

  async remove(accountId: string): Promise<boolean> {
    const all = await this.list();
    const next = all.filter((a) => a.accountId !== accountId);
    if (next.length === all.length) return false;
    await this.kv.set(ACCOUNTS_KV_KEY, JSON.stringify(next));
    return true;
  }
}

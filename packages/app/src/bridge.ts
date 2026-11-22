/** Window bridge injected by apps/desktop preload; web build gets fallbacks. */
import type { LinnetConfig, UpdateSnapshot, UpdateState } from "@linnet/core";

export interface KvBridge {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SecretBridge {
  save(key: string, value: string): Promise<void>;
  load(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

/** W18 update surface (see apps/desktop/src/updater.ts). */
export interface UpdatesBridge {
  get(): Promise<UpdateSnapshot>;
  check(): Promise<UpdateState>;
  download(): Promise<{ ok: boolean; reason?: string }>;
  install(): Promise<{ ok: boolean; reason?: string }>;
  setEnabled(on: boolean): Promise<UpdateSnapshot>;
  onEvent(cb: (snapshot: UpdateSnapshot) => void): () => void;
}

declare global {
  interface Window {
    linnet?: {
      getConfig(): Promise<Partial<LinnetConfig>>;
      platform: string;
      version: string;
      updates?: UpdatesBridge;
      kv?: KvBridge;
      secrets?: SecretBridge;
      setBadge?(count: number): Promise<void>;
      openExternal?(url: string): void;
      /** P1 URL previews: main-process HTML fetch (no CORS/cookies in renderer). */
      fetchUrl?(url: string): Promise<{ ok: boolean; status: number; html: string | null } | null>;
    };
  }
}

export async function readConfig(): Promise<Partial<LinnetConfig>> {
  if (window.linnet) {
    try {
      return await window.linnet.getConfig();
    } catch {
      /* fall through to defaults */
    }
  }
  return {};
}

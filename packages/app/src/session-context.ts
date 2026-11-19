/**
 * Singleton SessionManager + port selection. Desktop (window.linnet present):
 * OS-keychain-backed kv/secrets via preload IPC. Web build: in-memory only —
 * tokens intentionally NOT persisted in localStorage here (PRD §8 proposed
 * ladder B is the durable fix; disclose in docs/self-host.md).
 */
import {
  MemoryKv,
  MemorySecrets,
  SessionManager,
  type KvPort,
  type SecretPort,
} from "@linnet/core";
import type { KvBridge, SecretBridge } from "./bridge.js";

function fromBridgeKv(kv: KvBridge): KvPort {
  return {
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, v),
    delete: (k) => kv.remove(k),
  };
}
function fromBridgeSecrets(s: SecretBridge): SecretPort {
  return {
    save: (k, v) => s.save(k, v),
    load: (k) => s.load(k),
    remove: (k) => s.remove(k),
  };
}

let singleton: SessionManager | null = null;

export function getSessionManager(): SessionManager {
  if (!singleton) singleton = buildManager({});
  return singleton;
}

export function buildManager(overrides: {
  kv?: KvPort;
  secrets?: SecretPort;
  fetchFn?: typeof globalThis.fetch;
}): SessionManager {
  const bridge = typeof window !== "undefined" ? window.linnet : undefined;
  const kv = overrides.kv ?? (bridge?.kv ? fromBridgeKv(bridge.kv) : new MemoryKv());
  const secrets =
    overrides.secrets ?? (bridge?.secrets ? fromBridgeSecrets(bridge.secrets) : new MemorySecrets());
  return new SessionManager({ kv, secrets, fetchFn: overrides.fetchFn });
}

/** test seam */
export function setSessionManagerForTests(m: SessionManager): void {
  singleton?.stopAll();
  singleton = m;
}

/**
 * W14-E2EE-UNLOCK unit tests: the unlock-session lifecycle functions against
 * mocked crypto + a real ServerSideSecretStorageImpl over an in-memory
 * account-data store (genuine AES-HMAC-SHA2 payloads — the proof-before-mutate
 * guarantee is only meaningful against real encryption). No HS needed.
 */
import { describe, expect, it } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { keyFromAuthData } from "matrix-js-sdk/lib/common-crypto/key-passphrase.js";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { ServerSideSecretStorageImpl } from "matrix-js-sdk/lib/secret-storage.js";
import {
  bootstrapSecurity,
  getUnlockedSsssKey,
  setUnlockedSsssKey,
  unlockWithSecret,
  type UnlockSecret,
} from "./e2ee.js";

const KEY_ID = "alpha123";
const PASSPHRASE = "correct horse subrosa test";
const SALT = "unit-test-salt";
const ITERATIONS = 1; // 1 = fast PBKDF2, still the real code path

type Store = Map<string, Record<string, unknown>>;

async function derivedKey(passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  return (await keyFromAuthData(
    { private_key_salt: SALT, private_key_iterations: ITERATIONS, private_key_bits: 256 } as never,
    passphrase,
  )) as Uint8Array<ArrayBuffer>;
}

/** account data shaped like a passphrase-backed SSSS account (4S already set up) */
function mkStore(): Store {
  const store: Store = new Map();
  store.set("m.secret_storage.default_key", { key: KEY_ID });
  store.set(`m.secret_storage.key.${KEY_ID}`, {
    algorithm: "m.secret_storage.v1.aes-hmac-sha2",
    name: "linnet unit key",
    passphrase: { algorithm: "m.pbkdf2", iterations: ITERATIONS, salt: SALT },
  });
  return store;
}

/** encrypt a secret into the store under the given SSSS key (real AES+MAC) */
async function encryptInto(store: Store, key: Uint8Array<ArrayBuffer>, name: string, secret: string): Promise<void> {
  const adapter = {
    getAccountDataFromServer: async (t: string) => (store.get(t) ?? null) as never,
    setAccountData: async (t: string, c: Record<string, unknown>) => {
      store.set(t, c);
      return {} as never;
    },
  };
  const writer = new ServerSideSecretStorageImpl(adapter as never, {
    getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => [Object.keys(keys)[0], key],
  });
  await writer.store(name as never, secret);
}

interface CryptoCalls {
  bootstrapCrossSigning: number;
  checkKeyBackupAndEnable: number;
  restoreKeyBackup: number;
  keysQuery: number;
  storeSessionBackupPrivateKey?: number;
}

function mkCrypto(opts: {
  calls: CryptoCalls;
  ssssReady?: boolean;
  backupExists?: boolean;
  restoreTotal?: number;
}): MatrixClient {
  const { calls } = opts;
  const crypto = {
    isSecretStorageReady: async () => opts.ssssReady ?? false,
    getKeyBackupInfo: async () => (opts.backupExists === false ? null : { version: "1" }),
    getUserDeviceInfo: async () => {
      calls.keysQuery++;
      return new Map();
    },
    bootstrapCrossSigning: async () => {
      calls.bootstrapCrossSigning++;
    },
    checkKeyBackupAndEnable: async () => {
      calls.checkKeyBackupAndEnable++;
      return { backupInfo: { version: "1" } };
    },
    restoreKeyBackup: async (o?: { progressCallback?: (p: unknown) => void }) => {
      calls.restoreKeyBackup++;
      o?.progressCallback?.({ total: 6, imported: 3 });
      o?.progressCallback?.({ total: 6, imported: 6 });
      return { total: opts.restoreTotal ?? 6 };
    },
    storeSessionBackupPrivateKey: async () => {
      calls.storeSessionBackupPrivateKey = (calls.storeSessionBackupPrivateKey ?? 0) + 1;
    },
  };
  return crypto as unknown as MatrixClient;
}

function mkClient(store: Store, crypto: MatrixClient): MatrixClient {
  return {
    getCrypto: () => crypto as never,
    getUserId: () => "@alice:hs.test",
    getAccountData: (t: string) => (store.has(t) ? { getContent: () => store.get(t) } : undefined),
    getAccountDataFromServer: async (t: string) => store.get(t) ?? null,
  } as unknown as MatrixClient;
}

describe("W14 bootstrapSecurity guard", () => {
  it("refuses to bootstrap an account that already has Secure Secret Storage", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const crypto = mkCrypto({ calls, ssssReady: true });
    const client = mkClient(mkStore(), crypto);
    await expect(
      bootstrapSecurity({ client, userId: "@alice:hs.test", password: "pw", passphrase: "passphrase1" }),
    ).rejects.toThrow(/already has Secure Secret Storage/);
    expect(calls.bootstrapCrossSigning).toBe(0);
  });

  it("passes the guard when the account has no SSSS yet (fresh-account wizard)", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const crypto = {
      ...mkCrypto({ calls }),
      createRecoveryKeyFromPassphrase: async () => ({ privateKey: new Uint8Array(32), encodedPrivateKey: "RK" }),
      bootstrapSecretStorage: async () => undefined,
    };
    const client = mkClient(mkStore(), crypto as unknown as MatrixClient);
    const r = await bootstrapSecurity({ client, userId: "@a", password: "pw", passphrase: "passphrase1" });
    expect(r.recoveryKey).toBe("RK");
    expect(calls.bootstrapCrossSigning).toBe(1);
  });
});

describe("W14 unlockWithSecret", () => {
  it("passphrase path: proves via master secret, serves the key, imports the backup", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const store = mkStore();
    const key = await derivedKey(PASSPHRASE);
    await encryptInto(store, key, "m.cross_signing.master", "bWFzdGVyLXNlY3JldA==");
    await encryptInto(store, key, "m.megolm_backup.v1", "a2V5LWJhY2t1cA==");
    const client = mkClient(store, mkCrypto({ calls }));
    const progress: Array<{ total?: number; imported?: number }> = [];
    const res = await unlockWithSecret({
      client,
      secret: { passphrase: PASSPHRASE } as UnlockSecret,
      onProgress: (p) => progress.push(p),
    });
    expect(res.imported).toBe(6);
    expect(progress).toEqual([
      { total: 6, imported: 3 },
      { total: 6, imported: 6 },
    ]);
    // the client-level callback source is now populated — THE fix for the
    // "getSecretStorageKey callback returned falsey" crash
    expect(getUnlockedSsssKey(client)).toEqual(key);
    expect(calls.keysQuery).toBe(1); // public keys force-fed before import
    expect(calls.bootstrapCrossSigning).toBe(1);
    // HS-A-proven: restoreKeyBackup only works with the backup key CACHED in
    // the machine — unlockWithSecret must feed it from 4S first
    expect(calls.storeSessionBackupPrivateKey).toBe(1);
    expect(calls.checkKeyBackupAndEnable).toBe(1);
    expect(calls.restoreKeyBackup).toBe(1);
  });

  it("wrong passphrase throws BEFORE mutating anything", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const store = mkStore();
    const otherKey = new Uint8Array(32).fill(99); // secret stored under a DIFFERENT key
    await encryptInto(store, otherKey, "m.cross_signing.master", "c2VjcmV0");
    const client = mkClient(store, mkCrypto({ calls }));
    await expect(unlockWithSecret({ client, secret: { passphrase: PASSPHRASE } })).rejects.toThrow(
      "wrong passphrase or recovery key",
    );
    expect(getUnlockedSsssKey(client)).toBeUndefined();
    expect(calls.bootstrapCrossSigning).toBe(0);
    expect(calls.restoreKeyBackup).toBe(0);
  });

  it("recovery key path: the key bytes themselves authenticate", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const store = mkStore();
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i;
    await encryptInto(store, key, "m.cross_signing.master", "bWFzdGVy");
    const client = mkClient(store, mkCrypto({ calls }));
    const res = await unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(key)! } });
    expect(res.imported).toBe(6);
    expect(getUnlockedSsssKey(client)).toEqual(key);
    expect(calls.bootstrapCrossSigning).toBe(1);
  });

  it("wrong recovery key throws before mutating", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const store = mkStore();
    const right = new Uint8Array(32).fill(3);
    const wrong = new Uint8Array(32).fill(4);
    await encryptInto(store, right, "m.cross_signing.master", "bWFzdGVy");
    const client = mkClient(store, mkCrypto({ calls }));
    await expect(unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(wrong)! } })).rejects.toThrow(
      "wrong passphrase or recovery key",
    );
    expect(calls.bootstrapCrossSigning).toBe(0);
  });

  it("no master secret but backup exists: proven via m.megolm_backup.v1", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const store = mkStore();
    const key = await derivedKey(PASSPHRASE);
    await encryptInto(store, key, "m.megolm_backup.v1", "YmFja3VwLWtleQ==");
    const client = mkClient(store, mkCrypto({ calls }));
    const res = await unlockWithSecret({ client, secret: { passphrase: PASSPHRASE } });
    expect(res.imported).toBe(6);
    expect(calls.bootstrapCrossSigning).toBe(1);
  });

  it("backup secret encrypted under the WRONG key still rejects", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const store = mkStore();
    await encryptInto(store, new Uint8Array(32).fill(77), "m.megolm_backup.v1", "YmFja3Vw");
    const client = mkClient(store, mkCrypto({ calls }));
    await expect(unlockWithSecret({ client, secret: { passphrase: PASSPHRASE } })).rejects.toThrow(
      "wrong passphrase or recovery key",
    );
    expect(calls.bootstrapCrossSigning).toBe(0);
  });

  it("no secrets at all and no backup -> nothing-to-unlock error", async () => {
    const calls: CryptoCalls = { bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 };
    const client = mkClient(mkStore(), mkCrypto({ calls, backupExists: false }));
    await expect(unlockWithSecret({ client, secret: { passphrase: PASSPHRASE } })).rejects.toThrow(
      "nothing to unlock — no secrets found in secret storage",
    );
    expect(getUnlockedSsssKey(client)).toBeUndefined();
  });

  it("set/get unlocked key round-trips per client", () => {
    const a = {} as MatrixClient;
    const b = {} as MatrixClient;
    const k = new Uint8Array([1, 2, 3]);
    setUnlockedSsssKey(a, k as Uint8Array<ArrayBuffer>);
    expect(getUnlockedSsssKey(a)).toBe(k);
    expect(getUnlockedSsssKey(b)).toBeUndefined();
  });
});

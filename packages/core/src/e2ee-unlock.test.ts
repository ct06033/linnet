/**
 * W14-E2EE-UNLOCK unit tests: the unlock-session lifecycle functions against
 * mocked crypto + a real ServerSideSecretStorageImpl over an in-memory
 * account-data store (genuine AES-HMAC-SHA2 payloads — the proof-before-mutate
 * guarantee is only meaningful against real encryption). No HS needed.
 */
import { describe, expect, it } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { keyFromAuthData } from "matrix-js-sdk/lib/common-crypto/key-passphrase.js";
import { decodeRecoveryKey, encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { SECRET_STORAGE_ALGORITHM_V1_AES, ServerSideSecretStorageImpl } from "matrix-js-sdk/lib/secret-storage.js";
import encryptAESSecretStorageItem from "matrix-js-sdk/lib/utils/encryptAESSecretStorageItem.js";
import {
  bootstrapSecurity,
  cleanRecoveryKey,
  decryptSecretWithKey,
  getUnlockedSsssKey,
  restoreBackupWithPassphrase,
  restoreBackupWithRecoveryKey,
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

describe("W21-HOTFIX recovery-key input hardening (Sean prod report 11-24)", () => {
  const mkCalls = (): CryptoCalls => ({ bootstrapCrossSigning: 0, checkKeyBackupAndEnable: 0, restoreKeyBackup: 0, keysQuery: 0 });

  it("normalizes whitespace around a structurally valid key (reaches the auth check, not a decode error)", async () => {
    const raw = encodeRecoveryKey(new Uint8Array(32).fill(7));
    const client = mkClient(mkStore(), mkCrypto({ calls: mkCalls() }));
    await expect(
      unlockWithSecret({ client, secret: { recoveryKey: `\n ${raw!.replace(/ /g, " ")} \t` } as UnlockSecret }),
    ).rejects.toThrow(/wrong passphrase or recovery key|nothing to unlock/);
  });

  it("maps a bad-checksum key to actionable copy (was: raw 'Incorrect parity')", async () => {
    const client = mkClient(mkStore(), mkCrypto({ calls: mkCalls() }));
    await expect(
      unlockWithSecret({ client, secret: { recoveryKey: "EoJp EoJp EoJp EoJp EoJp EoJp EoJp EoJp EoJp EoJp EoJp EoJp Eo" } as UnlockSecret }),
    ).rejects.toThrow(/failed its checksum/);
  });

  it("maps a legacy/base64-shaped key (non-base58 chars) to the passphrase hint", async () => {
    const client = mkClient(mkStore(), mkCrypto({ calls: mkCalls() }));
    await expect(
      unlockWithSecret({ client, secret: { recoveryKey: "eH6abc0OIl+//==".trim() } as UnlockSecret }),
    ).rejects.toThrow(/doesn't look like a recovery key/);
  });

  it("bootstrapSecurity keeps honest messages for wrong-password UIA rejections", async () => {
    const store = mkStore();
    store.delete("m.secret_storage.default_key");
    store.delete(`m.secret_storage.key.${KEY_ID}`);
    const crypto = {
      ...mkCrypto({ calls: mkCalls(), ssssReady: false }),
      bootstrapCrossSigning: async () => {
        throw new Error("Invalid password");
      },
    };
    const client = mkClient(store, crypto as unknown as MatrixClient);
    await expect(
      bootstrapSecurity({ client, userId: "@a:t", password: "x", passphrase: "long enough" }),
    ).rejects.toThrow(/Invalid password/);
  });

  it("bootstrapSecurity reframes opaque already-has-keys failures with routing advice", async () => {
    const store = mkStore();
    store.delete("m.secret_storage.default_key");
    store.delete(`m.secret_storage.key.${KEY_ID}`);
    const crypto = {
      ...mkCrypto({ calls: mkCalls(), ssssReady: false }),
      bootstrapCrossSigning: async () => {
        throw new Error("Cannot reset cross-signing keys: this session does not have the private keys");
      },
    };
    const client = mkClient(store, crypto as unknown as MatrixClient);
    await expect(
      bootstrapSecurity({ client, userId: "@a:t", password: "x", passphrase: "long enough" }),
    ).rejects.toThrow(/already has encryption keys from another app/);
  });
});

// ---------------------------------------------------------------------------
// W22 SSSS FRAGILITY — the exact production failure shape (Sean, 0.2.4):
// a secret whose `encrypted` map carries a STALE entry A alongside the
// current default entry B. Pre-fix, unlockWithSecret's single-shot sss.get()
// answered B (default wins), decrypted B's entry with A's key bytes and threw
// raw "Error decrypting secret …: bad MAC" — even though A's copy decrypts
// fine. The red tests below reproduce the OLD path verbatim against the same
// data; the green tests prove the decryptSecretWithKey multi-copy retry fixes
// it. All payloads are real AES-HMAC-SHA2 via the SDK's own routines.
// ---------------------------------------------------------------------------
describe("W22 SSSS multi-entry fragility (stale key entries, real AES)", () => {
  const KEY_OLD = "oldkey01"; // "A" — the key the user still holds (Element printed its recovery key before the rotation)
  const KEY_NEW = "newkey02"; // "B" — current default key
  const KEY_PASS = "passkey03"; // passphrase-derived key in the last test
  const MASTER_B64 = "bWFzdGVyLXNlY3JldA==";
  const BACKUP_B64 = "a2V5LWJhY2t1cA==";

  const keyA = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff) as Uint8Array<ArrayBuffer>;
  const keyB = new Uint8Array(32).map((_, i) => (i * 11 + 2) & 0xff) as Uint8Array<ArrayBuffer>;
  const keyC = new Uint8Array(32).map((_, i) => (i * 13 + 3) & 0xff) as Uint8Array<ArrayBuffer>;

  async function enc(secret: string, key: Uint8Array<ArrayBuffer>, name: string): Promise<{ iv: string; ciphertext: string; mac: string }> {
    return (await encryptAESSecretStorageItem(secret, key, name)) as {
      iv: string;
      ciphertext: string;
      mac: string;
    };
  }

  /** m.cross_signing.master + m.megolm_backup.v1, EACH encrypted under BOTH
   *  keys (real AES), default = B — the archaeology state from the brief. */
  async function mkMultiStore(): Promise<Store> {
    const store: Store = new Map();
    store.set("m.secret_storage.default_key", { key: KEY_NEW });
    store.set(`m.secret_storage.key.${KEY_OLD}`, { algorithm: SECRET_STORAGE_ALGORITHM_V1_AES, name: "old key" });
    store.set(`m.secret_storage.key.${KEY_NEW}`, { algorithm: SECRET_STORAGE_ALGORITHM_V1_AES, name: "current key" });
    store.set("m.cross_signing.master", {
      encrypted: {
        [KEY_OLD]: await enc(MASTER_B64, keyA, "m.cross_signing.master"),
        [KEY_NEW]: await enc(MASTER_B64, keyB, "m.cross_signing.master"),
      },
    });
    store.set("m.megolm_backup.v1", {
      encrypted: {
        [KEY_OLD]: await enc(BACKUP_B64, keyA, "m.megolm_backup.v1"),
        [KEY_NEW]: await enc(BACKUP_B64, keyB, "m.megolm_backup.v1"),
      },
    });
    return store;
  }

  const mkCalls = (): CryptoCalls => ({
    bootstrapCrossSigning: 0,
    checkKeyBackupAndEnable: 0,
    restoreKeyBackup: 0,
    keysQuery: 0,
  });

  it("RED PROOF: the pre-W22 single-shot get() dies with raw bad MAC on A's bytes (old code fails — proven against the same data)", async () => {
    const store = await mkMultiStore();
    const client = mkClient(store, mkCrypto({ calls: mkCalls() }));
    const sss = new ServerSideSecretStorageImpl(client as never, {
      // exact pre-W22 callback: pickSsssKeyId semantics (default wins, else
      // keys[0]) + the user's ONE candidate key
      getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => {
        const def = (store.get("m.secret_storage.default_key") as { key?: string } | undefined)?.key;
        const keyId = def && Object.prototype.hasOwnProperty.call(keys, def) ? def : Object.keys(keys)[0];
        return [keyId, keyA];
      },
    });
    await expect(sss.get("m.cross_signing.master" as never)).rejects.toThrow(
      /Error decrypting secret m\.cross_signing\.master: bad MAC/,
    );
  });

  it("GREEN: unlockWithSecret with the STALE key A succeeds — every copy is tried (default-first, then the rest)", async () => {
    const calls = mkCalls();
    const store = await mkMultiStore();
    const client = mkClient(store, mkCrypto({ calls }));
    const res = await unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(keyA)! } });
    expect(res.imported).toBe(6);
    expect(res.crossSigningImported).toBe(true);
    expect(getUnlockedSsssKey(client)).toEqual(keyA);
    expect(calls.bootstrapCrossSigning).toBe(1);
    expect(calls.storeSessionBackupPrivateKey).toBe(1);
    expect(calls.restoreKeyBackup).toBe(1);
  });

  it("GREEN: unlockWithSecret with the CURRENT default key B still succeeds (ordering: default tried first)", async () => {
    const calls = mkCalls();
    const store = await mkMultiStore();
    const client = mkClient(store, mkCrypto({ calls }));
    const res = await unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(keyB)! } });
    expect(res.imported).toBe(6);
    expect(getUnlockedSsssKey(client)).toEqual(keyB);
  });

  it("a key that matches NO copy rejects with the actionable 'wrong passphrase or recovery key' — no raw bad MAC, no mutation", async () => {
    const calls = mkCalls();
    const store = await mkMultiStore();
    const client = mkClient(store, mkCrypto({ calls }));
    await expect(
      unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(keyC)! } }),
    ).rejects.toThrow(/wrong passphrase or recovery key/);
    expect(getUnlockedSsssKey(client)).toBeUndefined();
    expect(calls.bootstrapCrossSigning).toBe(0);
    expect(calls.restoreKeyBackup).toBe(0);
  });

  it("decryptSecretWithKey: real AES round-trips per copy; unsupported-algorithm and malformed entries are SKIPPED, not fatal", async () => {
    const store = await mkMultiStore();
    // entry under a key whose algorithm we cannot handle
    store.set("m.secret_storage.key.curvy", { algorithm: "m.secret_storage.v2.curvy-not-supported", name: "weird" });
    (store.get("m.cross_signing.master") as { encrypted: Record<string, unknown> }).encrypted.curvy = {
      iv: "AAAAAAAAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      mac: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    // entry with a valid AES key description but a MALFORMED payload (no mac)
    store.set("m.secret_storage.key.broken", { algorithm: SECRET_STORAGE_ALGORITHM_V1_AES, name: "broken" });
    (store.get("m.cross_signing.master") as { encrypted: Record<string, unknown> }).encrypted.broken = {
      iv: "AAAAAAAAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    };
    const client = mkClient(store, mkCrypto({ calls: mkCalls() }));
    // the extra entries must not stop either valid copy from decrypting
    await expect(decryptSecretWithKey(client, "m.cross_signing.master", keyA)).resolves.toBe(MASTER_B64);
    await expect(decryptSecretWithKey(client, "m.cross_signing.master", keyB)).resolves.toBe(MASTER_B64);
    await expect(decryptSecretWithKey(client, "m.megolm_backup.v1", keyB)).resolves.toBe(BACKUP_B64);
    // no copy matches -> null (no throw)
    await expect(decryptSecretWithKey(client, "m.cross_signing.master", keyC)).resolves.toBeNull();
  });

  it("decryptSecretWithKey: absent secret -> null; NEVER mutates the stored account data", async () => {
    const store = await mkMultiStore();
    const snapshot = JSON.stringify([...store.entries()]);
    const client = mkClient(store, mkCrypto({ calls: mkCalls() }));
    await expect(decryptSecretWithKey(client, "m.megolm_backup.v1.does-not-exist", keyA)).resolves.toBeNull();
    await expect(decryptSecretWithKey(client, "m.cross_signing.master", keyC)).resolves.toBeNull();
    expect(JSON.stringify([...store.entries()])).toBe(snapshot);
  });

  it("GREEN: fresh-session race — the flow runs on a client whose LOCAL account-data cache is empty; all reads hit the server (the pre-W22 local getAccountData reads saw NOTHING here)", async () => {
    const store = mkStore(); // passphrase-backed SSSS under KEY_ID
    const key = await derivedKey(PASSPHRASE);
    await encryptInto(store, key, "m.cross_signing.master", MASTER_B64);
    await encryptInto(store, key, "m.megolm_backup.v1", BACKUP_B64);
    const calls = mkCalls();
    const client = {
      getCrypto: () => mkCrypto({ calls }) as never,
      getUserId: () => "@alice:hs.test",
      getAccountData: undefined, // sync hasn't delivered account data yet
      getAccountDataFromServer: async (t: string) => store.get(t) ?? null,
    } as unknown as MatrixClient;
    // RED marker: the pre-W22 reads used client.getAccountData — empty here,
    // so deriveSsssKeyFromPassphrase threw "no default secret storage key
    // configured" on a CORRECT passphrase.
    expect((client as unknown as { getAccountData: unknown }).getAccountData).toBeUndefined();
    const res = await unlockWithSecret({ client, secret: { passphrase: PASSPHRASE } });
    expect(res.imported).toBe(6);
    expect(getUnlockedSsssKey(client)).toEqual(key);
  });

  it("step-4 honesty: when the SDK-internal single-shot cross-signing import fails with a bad MAC (documented limitation), unlock still restores the backup and reports crossSigningImported=false — the raw string never leaks", async () => {
    const calls = mkCalls();
    const store = await mkMultiStore();
    const crypto = {
      ...mkCrypto({ calls }),
      bootstrapCrossSigning: async () => {
        throw new Error("Error decrypting secret m.cross_signing.master: bad MAC");
      },
    };
    const client = mkClient(store, crypto as unknown as MatrixClient);
    const res = await unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(keyA)! } });
    expect(res.crossSigningImported).toBe(false);
    expect(res.imported).toBe(6); // history restore proceeded — the user's actual goal
  });

  it("step-4 honesty: wrong-password/UIA rejections from bootstrapCrossSigning still propagate VERBATIM", async () => {
    const calls = mkCalls();
    const store = await mkMultiStore();
    const crypto = {
      ...mkCrypto({ calls }),
      bootstrapCrossSigning: async () => {
        throw new Error("Invalid password");
      },
    };
    const client = mkClient(store, crypto as unknown as MatrixClient);
    await expect(
      unlockWithSecret({ client, secret: { recoveryKey: encodeRecoveryKey(keyA)! } }),
    ).rejects.toThrow(/Invalid password/);
  });

  it("cleanRecoveryKey strips every kind of whitespace", () => {
    expect(cleanRecoveryKey(" \nEoJp\t EoJp\r\n EoJp ")).toBe("EoJpEoJpEoJp");
    expect(cleanRecoveryKey("ABC")).toBe("ABC");
  });

  it("restoreBackupWithRecoveryKey accepts a newline-wrapped copy (the b28e991 hotfix missed this entry point; raw decodeRecoveryKey only tolerates PLAIN spaces)", async () => {
    const store = mkStore();
    const key = new Uint8Array(32).map((_, i) => (i * 5 + 9) & 0xff) as Uint8Array<ArrayBuffer>;
    await encryptInto(store, key, "m.megolm_backup.v1", BACKUP_B64);
    const wrapped = encodeRecoveryKey(key)!.replace(/ /g, "\n"); // line-wrapped copy/paste
    // RED marker: pre-W22 fed this straight to decodeRecoveryKey — bs58 dies
    expect(() => decodeRecoveryKey(wrapped)).toThrow();
    const calls = mkCalls();
    const client = mkClient(store, mkCrypto({ calls }));
    const imported = await restoreBackupWithRecoveryKey(client, `\t${wrapped} `);
    expect(imported).toBe(6);
    expect(calls.restoreKeyBackup).toBe(1);
  });

  it("restoreBackupWithPassphrase: stale-entry multi-copy backup secret decrypts with the current passphrase (single-shot pre-W22 hit bad MAC)", async () => {
    // same archaeology shape but the DEFAULT key is passphrase-derived, so the
    // derived bytes ARE keyB: entry {A(old),B(current)} — B first wins.
    const store = await mkMultiStore();
    const passKey = await derivedKey(PASSPHRASE);
    store.set("m.secret_storage.default_key", { key: KEY_PASS });
    store.set(`m.secret_storage.key.${KEY_PASS}`, {
      algorithm: SECRET_STORAGE_ALGORITHM_V1_AES,
      name: "pass key",
      passphrase: { algorithm: "m.pbkdf2", iterations: ITERATIONS, salt: SALT },
    });
    store.set("m.megolm_backup.v1", {
      encrypted: {
        [KEY_OLD]: await enc(BACKUP_B64, keyA, "m.megolm_backup.v1"),
        [KEY_PASS]: await enc(BACKUP_B64, passKey, "m.megolm_backup.v1"),
      },
    });
    const calls = mkCalls();
    const client = mkClient(store, mkCrypto({ calls }));
    await expect(restoreBackupWithPassphrase(client, PASSPHRASE)).resolves.toBe(6);
  });
});

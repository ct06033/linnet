/**
 * W24 ROUTE E unit tests — rotateRecoveryMethod against mocked crypto + a
 * REAL ServerSideSecretStorageImpl over an in-memory account-data store
 * (genuine AES-HMAC-SHA2 payloads, same harness pattern as W22's
 * e2ee-unlock.test.ts). Proves: proof-decrypts precede every write; failed
 * proof mutates NOTHING; all secrets re-wrap under the NEW default; the old
 * key then decrypts nothing; the cross-signing step is the IMPORT branch
 * (never setupNewCrossSigning) with the forced keys-query first; edge H
 * completes without the cross-signing step; both proof routes (key AND
 * passphrase) work; whitespace-normalized keys reach decrypt.
 */
import { describe, expect, it } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { keyFromAuthData } from "matrix-js-sdk/lib/common-crypto/key-passphrase.js";
import { decodeRecoveryKey, encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { SECRET_STORAGE_ALGORITHM_V1_AES, ServerSideSecretStorageImpl } from "matrix-js-sdk/lib/secret-storage.js";
import encryptAESSecretStorageItem from "matrix-js-sdk/lib/utils/encryptAESSecretStorageItem.js";
import {
  cleanRecoveryKey,
  decryptSecretWithKey,
  getBootstrapKey,
  getUnlockedSsssKey,
  pickSsssKeyId,
  rememberBootstrapKey,
  rotateRecoveryMethod,
  setUnlockedSsssKey,
  type UnlockSecret,
} from "./e2ee.js";

const K1_ID = "keyid_k1"; // the CURRENT (old) default SSSS key id
const K2_ID = "keyid_k2"; // what the fake bootstrapSecretStorage publishes
const P1 = "old passphrase alpha"; // current passphrase (proof flavor #2)
const P2 = "brand new phrase beta"; // the NEW passphrase the user chooses
const SALT = "unit-test-salt";
const NEWSALT = "unit-test-newsalt";
const ITERATIONS = 1; // fast PBKDF2, real code path

const MASTER_B64 = "bWFzdGVyLXNlY3JldA==";
const SELF_B64 = "c2VsZi1zZWNyZXQ=";
const USER_B64 = "dXNlci1zZWNyZXQ=";
const BACKUP_B64 = "a2V5LWJhY2t1cA==";
const ALL_NAMES = [
  "m.cross_signing.master",
  "m.cross_signing.self_signing",
  "m.cross_signing.user_signing",
  "m.megolm_backup.v1",
] as const;

type Store = Map<string, Record<string, unknown>>;

// deterministic 32-byte keys (distinct)
const keyK1 = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff) as Uint8Array<ArrayBuffer>;
const keyK2 = new Uint8Array(32).map((_, i) => (i * 11 + 2) & 0xff) as Uint8Array<ArrayBuffer>; // the NEW key
const keyStale = new Uint8Array(32).map((_, i) => (i * 13 + 3) & 0xff) as Uint8Array<ArrayBuffer>; // W22 stale copy
const keyWrong = new Uint8Array(32).map((_, i) => (i * 17 + 4) & 0xff) as Uint8Array<ArrayBuffer>;

async function enc(secret: string, key: Uint8Array<ArrayBuffer>, name: string): Promise<Record<string, string>> {
  return (await encryptAESSecretStorageItem(secret, key, name)) as unknown as Record<string, string>;
}

/** passphrase-derived K1 bytes (same derivation unlock/rotate run) */
async function k1FromPassphrase(): Promise<Uint8Array<ArrayBuffer>> {
  return (await keyFromAuthData(
    { private_key_salt: SALT, private_key_iterations: ITERATIONS, private_key_bits: 256 } as never,
    P1,
  )) as Uint8Array<ArrayBuffer>;
}

interface Events {
  log: string[]; // ordered trace: read:<type> / write:<type> / create / boot-4S / xsign / keys ...
  writes: string[]; // setAccountData types
  bootOpts: unknown[]; // bootstrapSecretStorage args
  xsignOpts: unknown[]; // bootstrapCrossSigning args
  bootstrapped: number;
  xsign: number;
  keysQuery: number;
  storeSessionBackup: string[]; // base64s handed to the machine
  checkEnable: number;
  restore: number;
}

function mkEvents(): Events {
  return {
    log: [],
    writes: [],
    bootOpts: [],
    xsignOpts: [],
    bootstrapped: 0,
    xsign: 0,
    keysQuery: 0,
    storeSessionBackup: [],
    checkEnable: 0,
    restore: 0,
  };
}

/**
 * Build the fake rotating world: account data store pre-rotation (K1-era,
 * real AES payloads), the sdk.ts-mirroring ServerSideSecretStorageImpl for
 * client.secretStorage, and a fake crypto that mimics the VERIFIED 45.1
 * bootstrapSecretStorage behavior on a LOCKED device (adds the new key +
 * default id, does NOT re-store any secret — the machine caches nothing).
 */
function mkWorld(opts: { staleCopy?: boolean; omit?: string[] } = {}) {
  const ev = mkEvents();
  const store: Store = new Map();
  store.set("m.secret_storage.default_key", { key: K1_ID });
  store.set(`m.secret_storage.key.${K1_ID}`, {
    algorithm: SECRET_STORAGE_ALGORITHM_V1_AES,
    name: "k1 key",
    passphrase: { algorithm: "m.pbkdf2", iterations: ITERATIONS, salt: SALT },
  });
  if (opts.staleCopy) {
    store.set(`m.secret_storage.key.${"keyid_stale"}`, { algorithm: SECRET_STORAGE_ALGORITHM_V1_AES, name: "stale" });
  }

  const secrets: Record<string, string> = {
    "m.cross_signing.master": MASTER_B64,
    "m.cross_signing.self_signing": SELF_B64,
    "m.cross_signing.user_signing": USER_B64,
    "m.megolm_backup.v1": BACKUP_B64,
  };

  const client = {
    getUserId: () => "@alice:hs.test",
    getAccountDataFromServer: async (t: string) => {
      ev.log.push(`read:${t}`);
      return store.get(t) ?? null;
    },
    getAccountData: (t: string) => (store.has(t) ? { getContent: () => store.get(t) } : undefined),
    secretStorage: null as unknown as ServerSideSecretStorageImpl,
    getCrypto: () => crypto as never,
  } as unknown as MatrixClient & { secretStorage: ServerSideSecretStorageImpl };

  // the SAME client is the holder key — seed it before the impl uses it
  client.secretStorage = new ServerSideSecretStorageImpl(
    {
      getAccountDataFromServer: async (t: string) => {
        ev.log.push(`read:${t}`);
        return (store.get(t) ?? null) as never;
      },
      setAccountData: async (t: string, c: Record<string, unknown>) => {
        ev.log.push(`write:${t}`);
        ev.writes.push(t);
        store.set(t, c);
        return {} as never;
      },
    } as never,
    {
      // mirrors sdk.ts EXACTLY: bootstrap holder wins, else unlocked holder;
      // keyId via pickSsssKeyId (default-first)
      getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }) => {
        const privateKey = getBootstrapKey(client) ?? getUnlockedSsssKey(client);
        const keyId = await pickSsssKeyId(client, keys);
        return privateKey && keyId ? [keyId, privateKey] : null;
      },
    },
  );

  const crypto = {
    getKeyBackupInfo: async () => ({ version: "7" }),
    isSecretStorageReady: async () => true,
    createRecoveryKeyFromPassphrase: async (pass: string) => {
      ev.log.push("create-new-key");
      expect(pass).toBe(P2);
      return {
        keyInfo: {
          passphrase: { algorithm: "m.pbkdf2", iterations: ITERATIONS, salt: NEWSALT },
          name: "linnet passphrase key",
        },
        privateKey: keyK2,
        encodedPrivateKey: encodeRecoveryKey(keyK2),
      };
    },
    // verified 45.1 shape (rust-crypto.js:726): with setupNewSecretStorage it
    // creates + adds the key and sets the default — and on a locked device
    // re-stores NOTHING (no cached cross-signing/backup private keys here).
    bootstrapSecretStorage: async (o: { setupNewSecretStorage?: boolean }) => {
      ev.bootOpts.push(o);
      ev.log.push("boot-4S");
      ev.bootstrapped++;
      const gen = keyK2; // the fake generated key
      void gen;
      store.set(`m.secret_storage.key.${K2_ID}`, {
        algorithm: SECRET_STORAGE_ALGORITHM_V1_AES,
        name: "linnet passphrase key",
        passphrase: { algorithm: "m.pbkdf2", iterations: ITERATIONS, salt: NEWSALT },
      });
      store.set("m.secret_storage.default_key", { key: K2_ID });
      return { keyId: K2_ID };
    },
    getUserDeviceInfo: async () => {
      ev.log.push("keys-query");
      ev.keysQuery++;
      return new Map();
    },
    bootstrapCrossSigning: async (o: unknown) => {
      ev.log.push("xsign");
      ev.xsignOpts.push(o);
      ev.xsign++;
    },
    storeSessionBackupPrivateKey: async (k: Uint8Array, version: string) => {
      ev.storeSessionBackup.push(`${btoa(String.fromCharCode(...k))}@${version}`);
    },
    checkKeyBackupAndEnable: async () => {
      ev.checkEnable++;
      return { backupInfo: { version: "7" } };
    },
    restoreKeyBackup: async (o?: { progressCallback?: (p: unknown) => void }) => {
      ev.restore++;
      o?.progressCallback?.({ total: 6, imported: 6 });
      return { total: 6 };
    },
  };
  return { ev, store, client, crypto: crypto as never };
}

/** seed K1-era secrets (real AES) into the store under the given guard key */
async function seedK1(
  store: Store,
  opts: { staleCopy?: boolean; omit?: string[]; guardKey?: Uint8Array<ArrayBuffer> } = {},
): Promise<void> {
  const guard = opts.guardKey ?? keyK1;
  for (const name of ALL_NAMES) {
    if (opts.omit?.includes(name)) continue;
    const encrypted: Record<string, unknown> = { [K1_ID]: await enc(secretsOf(name), guard, name) };
    if (opts.staleCopy) encrypted.keyid_stale = await enc(secretsOf(name), keyStale, name);
    store.set(name, { encrypted });
  }
}

function secretsOf(name: string): string {
  switch (name) {
    case "m.cross_signing.master":
      return MASTER_B64;
    case "m.cross_signing.self_signing":
      return SELF_B64;
    case "m.cross_signing.user_signing":
      return USER_B64;
    default:
      return BACKUP_B64;
  }
}

const firstWriteIdx = (ev: Events): number => ev.log.findIndex((e) => e.startsWith("write:"));

describe("W24 rotateRecoveryMethod — happy path (recovery-key proof)", () => {
  it("re-wraps ALL four secrets under the new default; order, identity-preserving import, backup restore", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store);
    const keysSeen: string[] = [];
    const progress: Array<{ total?: number; imported?: number }> = [];
    const res = await rotateRecoveryMethod({
      client,
      userId: "@alice:hs.test",
      secret: { recoveryKey: encodeRecoveryKey(keyK1)! } as UnlockSecret,
      newPassphrase: P2,
      onKey: (k) => keysSeen.push(k),
      onProgress: (p) => progress.push(p),
    });

    // returned key IS the base58 of the NEW passphrase-derived bytes
    expect(res.recoveryKey).toBe(encodeRecoveryKey(keyK2));
    expect(decodeRecoveryKey(cleanRecoveryKey(res.recoveryKey))).toEqual(keyK2);
    expect(keysSeen).toEqual([res.recoveryKey]); // handed once, early

    // ORDER (brief rule): all four PROOF reads + decrypts happen BEFORE the
    // new key is even created; every write happens AFTER it.
    const createIdx = ev.log.indexOf("create-new-key");
    const proofReads = ALL_NAMES.map((n) => ev.log.indexOf(`read:${n}`));
    expect(Math.max(...proofReads)).toBeLessThan(createIdx);
    expect(firstWriteIdx(ev)).toBeGreaterThan(createIdx);

    // 4S ROTATED: default id changed, exactly one bootstrapSecretStorage call
    expect((store.get("m.secret_storage.default_key") as { key: string }).key).toBe(K2_ID);
    expect(ev.bootstrapped).toBe(1);
    expect((ev.bootOpts[0] as { setupNewSecretStorage?: boolean }).setupNewSecretStorage).toBe(true);

    // EVERY secret now decrypts with the NEW bytes and guards under K2_ID ONLY
    for (const name of ALL_NAMES) {
      await expect(decryptSecretWithKey(client, name, keyK2)).resolves.toBe(secretsOf(name));
      const map = (store.get(name) as { encrypted: Record<string, unknown> }).encrypted;
      expect(Object.keys(map)).toEqual([K2_ID]);
    }
    // THE OLD KEY IS RETIRED for 4S fetches (store() replaced the maps)
    for (const name of ALL_NAMES) {
      await expect(decryptSecretWithKey(client, name, keyK1)).resolves.toBeNull();
    }

    // IDENTITY PRESERVED: import branch ONLY — no setupNewCrossSigning, ever
    expect(ev.xsign).toBe(1);
    const xo = ev.xsignOpts[0] as Record<string, unknown>;
    expect(xo.setupNewCrossSigning).toBeFalsy();
    expect(xo.authUploadDeviceSigningKeys).toBeUndefined(); // no UIA in this flow
    // W14 trap: the forced keys-query precedes the import
    expect(ev.log.indexOf("keys-query")).toBeLessThan(ev.log.indexOf("xsign"));
    expect(ev.keysQuery).toBe(1);
    expect(res.crossSigningImported).toBe(true);
    expect(res.masterSecretWasStored).toBe(true);

    // BACKUP side (history NOW): machine fed the decrypted backup key for the
    // UNCHANGED version, then enabled + restored
    const expectedBackupBytes = Uint8Array.from(atob(BACKUP_B64), (c) => c.charCodeAt(0));
    expect(ev.storeSessionBackup).toEqual([`${btoa(String.fromCharCode(...expectedBackupBytes))}@7`]);
    expect(ev.checkEnable).toBe(1);
    expect(ev.restore).toBe(1);
    expect(res.imported).toBe(6);
    expect(progress).toEqual([{ total: 6, imported: 6 }]);

    // holders serve the NEW key after rotation (both sources — a previously
    // unlocked OLD key must not survive as the callback answer)
    expect(getBootstrapKey(client)).toEqual(keyK2);
    expect(getUnlockedSsssKey(client)).toEqual(keyK2);
  });
});

describe("W24 rotateRecoveryMethod — proof flavors + hygiene", () => {
  it("passphrase proof works too (same door)", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store, { guardKey: await k1FromPassphrase() });
    const k1 = await k1FromPassphrase();
    const res = await rotateRecoveryMethod({
      client,
      userId: "@alice:hs.test",
      secret: { passphrase: P1 } as UnlockSecret,
      newPassphrase: P2,
    });
    expect(res.crossSigningImported).toBe(true);
    await expect(decryptSecretWithKey(client, "m.cross_signing.master", keyK2)).resolves.toBe(MASTER_B64);
    await expect(decryptSecretWithKey(client, "m.cross_signing.master", k1)).resolves.toBeNull();
  });

  it("whitespace-wrapped key input reaches the decrypt (not a decode throw)", async () => {
    const { store, client } = mkWorld();
    await seedK1(store);
    const raw = encodeRecoveryKey(keyK1)!;
    // copy/paste line wraps + NBSP separators between every character
    const messy = `\n ${raw.split("").join("\u00a0")} \t`;
    const res = await rotateRecoveryMethod({
      client,
      userId: "@alice:hs.test",
      secret: { recoveryKey: messy } as UnlockSecret,
      newPassphrase: P2,
    });
    expect(res.masterSecretWasStored).toBe(true);
  });

  it("a stale-but-valid key copy authenticates the proof (W22 shape) and everything lands under K2 only", async () => {
    const { ev, store, client } = mkWorld({ staleCopy: true });
    await seedK1(store, { staleCopy: true });
    const res = await rotateRecoveryMethod({
      client,
      userId: "@alice:hs.test",
      secret: { recoveryKey: encodeRecoveryKey(keyStale)! } as UnlockSecret,
      newPassphrase: P2,
    });
    expect(res.masterSecretWasStored).toBe(true);
    for (const name of ALL_NAMES) {
      expect(Object.keys((store.get(name) as { encrypted: Record<string, unknown> }).encrypted)).toEqual([K2_ID]);
    }
    expect(ev.writes.length).toBeGreaterThan(0);
  });

  it("WRONG proof: actionable reject, NOTHING written, no crypto calls, holders untouched", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store);
    const snapshot = JSON.stringify([...store.entries()].sort());
    const freshClient = mkWorld().client; // holder isolation check base
    await expect(
      rotateRecoveryMethod({
        client,
        userId: "@alice:hs.test",
        secret: { recoveryKey: encodeRecoveryKey(keyWrong)! } as UnlockSecret,
        newPassphrase: P2,
      }),
    ).rejects.toThrow(/wrong passphrase or recovery key/);
    expect(JSON.stringify([...store.entries()].sort())).toBe(snapshot);
    expect(ev.writes).toEqual([]);
    expect(ev.bootstrapped).toBe(0);
    expect(ev.xsign).toBe(0);
    expect(ev.restore).toBe(0);
    expect(getBootstrapKey(freshClient)).toBeUndefined();
  });

  it("new passphrase under 8 chars rejects before ANY server reads", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store);
    await expect(
      rotateRecoveryMethod({
        client,
        userId: "@alice:hs.test",
        secret: { recoveryKey: encodeRecoveryKey(keyK1)! } as UnlockSecret,
        newPassphrase: "short",
      }),
    ).rejects.toThrow(/min 8/);
    expect(ev.log).toEqual([]);
    expect(ev.writes).toEqual([]);
  });

  it("malformed recovery-key input maps to the actionable W21 copy (never a raw decode throw)", async () => {
    const { store, client } = mkWorld();
    await seedK1(store);
    await expect(
      rotateRecoveryMethod({
        client,
        userId: "@alice:hs.test",
        secret: { recoveryKey: "eH6abc0OIl+//==" } as UnlockSecret,
        newPassphrase: P2,
      }),
    ).rejects.toThrow(/doesn't look like a recovery key/);
  });
});

describe("W24 edge H — cross-signing exists but master is NOT in 4S", () => {
  it("rotation completes via the backup-secret proof; NO cross-signing step; result flags it", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store, { omit: ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"] });
    const res = await rotateRecoveryMethod({
      client,
      userId: "@alice:hs.test",
      secret: { recoveryKey: encodeRecoveryKey(keyK1)! } as UnlockSecret,
      newPassphrase: P2,
    });
    expect(res.masterSecretWasStored).toBe(false);
    expect(res.crossSigningImported).toBe(false);
    // THE CROSS-SIGNING STEP NEVER RUNS (not even the import branch)
    expect(ev.xsign).toBe(0);
    expect(ev.keysQuery).toBe(0); // no point forcing the query with nothing to import
    // backup key still re-wrapped and history still restored
    await expect(decryptSecretWithKey(client, "m.megolm_backup.v1", keyK2)).resolves.toBe(BACKUP_B64);
    expect(Object.keys((store.get("m.megolm_backup.v1") as { encrypted: Record<string, unknown> }).encrypted)).toEqual([K2_ID]);
    expect(ev.restore).toBe(1);
    expect(res.imported).toBe(6);
  });
});

describe("W24 step-5 honesty (b28e991 rules carried over)", () => {
  it("a single-shot import failure (bad MAC family) does not abort: history still restores, crossSigningImported=false, raw string never leaks", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store);
    const c = client as unknown as { getCrypto(): Record<string, unknown> };
    (c.getCrypto() as { bootstrapCrossSigning: (o: unknown) => Promise<void> }).bootstrapCrossSigning = async () => {
      ev.xsign++;
      throw new Error("Error decrypting secret m.cross_signing.master: bad MAC");
    };
    const res = await rotateRecoveryMethod({
      client,
      userId: "@alice:hs.test",
      secret: { recoveryKey: encodeRecoveryKey(keyK1)! } as UnlockSecret,
      newPassphrase: P2,
    });
    expect(res.crossSigningImported).toBe(false);
    expect(res.imported).toBe(6);
    expect(String(res.recoveryKey)).toBeTruthy();
  });

  it("a wrong-password/UIA-shaped error from the SDK propagates VERBATIM (must not be swallowed)", async () => {
    const { ev, store, client } = mkWorld();
    await seedK1(store);
    const c = client as unknown as { getCrypto(): Record<string, unknown> };
    (c.getCrypto() as { bootstrapCrossSigning: (o: unknown) => Promise<void> }).bootstrapCrossSigning = async () => {
      ev.xsign++;
      throw new Error("403: Wrong credentials passed to UIA");
    };
    await expect(
      rotateRecoveryMethod({
        client,
        userId: "@alice:hs.test",
        secret: { recoveryKey: encodeRecoveryKey(keyK1)! } as UnlockSecret,
        newPassphrase: P2,
      }),
    ).rejects.toThrow(/Wrong credentials passed to UIA/);
  });
});

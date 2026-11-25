/**
 * W23 core unit tests — route B (resetSecurityAccess) and route D
 * (describeSecurityAccount / describeSecurityAccountText), against a mocked
 * crypto surface / fake account-data store. The ORDERING proof
 * (sss-rotate -> cross-signing with setupNewCrossSigning -> backup reset ->
 * enable) and the UIA PAYLOAD proof (identifier required, W5a trap) live
 * here; the real-server proof lives in e2ee-reset-live.test.ts.
 *
 * All mocked SDK shapes were transcribed from the installed
 * matrix-js-sdk@45.1.0 .d.ts / rust-crypto.js (Rule 1).
 */
import { describe, expect, it } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import {
  describeSecurityAccount,
  describeSecurityAccountText,
  getBootstrapKey,
  resetSecurityAccess,
} from "./e2ee.js";

// ---------------------------------------------------------------- route B

interface ResetProbe {
  order: string[];
  bssOpts?: Record<string, unknown> & {
    setupNewSecretStorage?: boolean;
    setupNewKeyBackup?: boolean;
    createSecretStorageKey?: () => Promise<unknown>;
  };
  bcsOpts?: { setupNewCrossSigning?: boolean };
  authPayload?: Record<string, unknown>;
  passphraseAsked?: string;
  capturedMakeRequest?: boolean;
}

const GEN = {
  privateKey: new Uint8Array(32).fill(7),
  encodedPrivateKey: "EwCQ TEST RECOVERY KEY 1234",
  keyInfo: { passphrase: { algorithm: "m.pbkdf2", salt: "salty", iterations: 1 } },
};

function mkResetCrypto(t: ResetProbe, failAt?: "uia" | "backup"): MatrixClient {
  const crypto = {
    createRecoveryKeyFromPassphrase: async (passphrase: string) => {
      t.order.push("create-key");
      t.passphraseAsked = passphrase;
      return GEN;
    },
    bootstrapSecretStorage: async (opts: ResetProbe["bssOpts"]) => {
      t.order.push("sss-rotate");
      t.bssOpts = opts;
    },
    bootstrapCrossSigning: async (opts: {
      setupNewCrossSigning?: boolean;
      authUploadDeviceSigningKeys?: (makeRequest: (data: Record<string, unknown>) => Promise<void>) => Promise<void>;
    }) => {
      t.order.push("cross-signing");
      t.bcsOpts = opts;
      if (opts.authUploadDeviceSigningKeys) {
        t.capturedMakeRequest = true;
        await opts.authUploadDeviceSigningKeys(async (data: Record<string, unknown>) => {
          t.authPayload = data;
          if (failAt === "uia") throw new Error("Invalid password");
        });
      }
    },
    resetKeyBackup: async () => {
      t.order.push("backup-reset");
      if (failAt === "backup") throw new Error("Internal server error 500");
    },
    checkKeyBackupAndEnable: async () => {
      t.order.push("backup-check");
      return null;
    },
  };
  return { getCrypto: () => crypto } as unknown as MatrixClient;
}

function freshProbe(): ResetProbe {
  return { order: [] };
}

describe("W23-B resetSecurityAccess", () => {
  it("orders the rotation ssss -> cross-signing -> backup delete/create -> enable", async () => {
    const t = freshProbe();
    const client = mkResetCrypto(t);
    const keysSeen: string[] = [];
    const r = await resetSecurityAccess({
      client,
      userId: "@alice:hs.test",
      password: "acct-pw",
      passphrase: "brand new phrase",
      onKey: (k) => keysSeen.push(k),
    });
    expect(t.order).toEqual(["create-key", "sss-rotate", "cross-signing", "backup-reset", "backup-check"]);
    expect(t.passphraseAsked).toBe("brand new phrase");
    // SSSS rotation opts: forced new storage, NO setupNewKeyBackup (step 3 owns it),
    // and the createSecretStorageKey callback hands back the SAME generated key.
    expect(t.bssOpts?.setupNewSecretStorage).toBe(true);
    expect(t.bssOpts?.setupNewKeyBackup).toBeUndefined();
    const handed = await t.bssOpts?.createSecretStorageKey?.();
    expect(handed).toBe(GEN);
    // cross-signing FORCED new (old cached private keys are gone — W23 rule)
    expect(t.bcsOpts?.setupNewCrossSigning).toBe(true);
    // result + early handoff + holder seeded for sdk.ts's callback
    expect(r.recoveryKey).toBe(GEN.encodedPrivateKey);
    expect(keysSeen).toEqual([GEN.encodedPrivateKey]);
    expect(getBootstrapKey(client)).toBe(GEN.privateKey);
  });

  it("UIA payload carries m.login.password WITH identifier (W5a trap: M_INVALID_PARAM without)", async () => {
    const t = freshProbe();
    const client = mkResetCrypto(t);
    await resetSecurityAccess({
      client,
      userId: "@alice:hs.test",
      password: "acct-pw",
      passphrase: "brand new phrase",
    });
    expect(t.capturedMakeRequest).toBe(true);
    expect(t.authPayload).toEqual({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "@alice:hs.test" },
      password: "acct-pw",
    });
  });

  it("wrong account password propagates VERBATIM and stops before the backup step", async () => {
    const t = freshProbe();
    const client = mkResetCrypto(t, "uia");
    await expect(
      resetSecurityAccess({ client, userId: "@a:hs.test", password: "nope", passphrase: "brand new phrase" }),
    ).rejects.toThrow("Invalid password"); // exact server message, not wrapped
    expect(t.order).toEqual(["create-key", "sss-rotate", "cross-signing"]); // no backup-reset
  });

  it("a late backup failure surfaces unmodified after onKey already fired", async () => {
    const t = freshProbe();
    const client = mkResetCrypto(t, "backup");
    const keysSeen: string[] = [];
    await expect(
      resetSecurityAccess({
        client,
        userId: "@a:hs.test",
        password: "pw",
        passphrase: "brand new phrase",
        onKey: (k) => keysSeen.push(k),
      }),
    ).rejects.toThrow("Internal server error 500");
    expect(keysSeen).toEqual([GEN.encodedPrivateKey]); // UI still holds the new key to show
  });

  it("rejects a short passphrase BEFORE touching crypto", async () => {
    const t = freshProbe();
    const client = mkResetCrypto(t);
    await expect(
      resetSecurityAccess({ client, userId: "@a:hs.test", password: "pw", passphrase: "short" }),
    ).rejects.toThrow(/passphrase too short \(min 8\)/);
    expect(t.order).toEqual([]);
  });

  it("requires an initialised crypto session", async () => {
    const client = { getCrypto: () => undefined } as unknown as MatrixClient;
    await expect(
      resetSecurityAccess({ client, userId: "@a:hs.test", password: "pw", passphrase: "long enough" }),
    ).rejects.toThrow(/crypto not initialised/);
  });
});

// ---------------------------------------------------------------- route D

const AES = "m.secret_storage.v1.aes-sha2";

interface DescClient {
  client: MatrixClient;
  authedCalls: Array<{ method: unknown; path: string }>;
}

function mkDescClient(
  store: Map<string, Record<string, unknown>>,
  backup: unknown = { version: "9", algorithm: "m.megolm.v1.aes-sha2", count: 3 },
  opts: { withLocalStore?: boolean } = {},
): DescClient {
  const authedCalls: Array<{ method: unknown; path: string }> = [];
  const localAccountData = new Map<string, unknown>();
  if (opts.withLocalStore !== false) {
    // a SYNCED session mirrors every account-data type locally — what
    // describeSecurityAccount enumerates for the key.* set
    for (const [type, content] of store) {
      localAccountData.set(type, { getContent: () => content });
    }
  }
  const client = {
    // server-first read seam used by W22 readAccountData
    getAccountDataFromServer: async (t: string) => store.get(t) ?? null,
    getAccountData: (t: string) => (store.has(t) ? { getContent: () => store.get(t) } : undefined),
    store: { accountData: localAccountData },
    getHomeserverUrl: () => "https://hs.test",
    getUserId: () => "@alice:hs.test",
    getCrypto: () => null,
    http: {
      authedRequest: async (method: unknown, path: string) => {
        authedCalls.push({ method, path });
        if (backup instanceof Error) throw backup;
        return backup;
      },
    },
  };
  return { client: client as unknown as MatrixClient, authedCalls };
}

function encEntry(tag: string): Record<string, unknown> {
  // realistic shape — the fields describeSecurityAccount must NEVER echo
  return {
    ciphertext: `SENTINEL-CIPHERTEXT-${tag}`,
    iv: `SENTINEL-IV-${tag}`,
    mac: `SENTINEL-MAC-${tag}`,
  };
}

function derivedDesc(name?: string): Record<string, unknown> {
  return {
    algorithm: AES,
    ...(name ? { name } : {}),
    passphrase: { algorithm: "m.pbkdf2", iterations: 500000, salt: "some-salt" },
  };
}

function mkAccountStore(opts: {
  defaultKeyId: string;
  keys: Record<string, Record<string, unknown>>;
  secrets: Record<string, string[]>; // secret name -> guarding key ids
}): Map<string, Record<string, unknown>> {
  const store = new Map<string, Record<string, unknown>>();
  store.set("m.secret_storage.default_key", { key: opts.defaultKeyId });
  for (const [id, desc] of Object.entries(opts.keys)) store.set(`m.secret_storage.key.${id}`, desc);
  for (const [name, ids] of Object.entries(opts.secrets)) {
    const encrypted: Record<string, unknown> = {};
    for (const id of ids) encrypted[id] = encEntry(`${name}:${id}`);
    store.set(name, { encrypted });
  }
  return store;
}

const ALL_SECRETS = (ids: string[]): Record<string, string[]> => ({
  "m.cross_signing.master": ids,
  "m.cross_signing.self_signing": ids,
  "m.cross_signing.user_signing": ids,
  "m.megolm_backup.v1": ids,
});

describe("W23-D describeSecurityAccount", () => {
  it("rule 2: passphrase-derived default key -> headline names the key, full non-secret detail", async () => {
    const store = mkAccountStore({
      defaultKeyId: "Bkey1234",
      keys: { Bkey1234: derivedDesc("Element security key") },
      secrets: ALL_SECRETS(["Bkey1234"]),
    });
    const { client, authedCalls } = mkDescClient(store);
    const d = await describeSecurityAccount(client);
    expect(d.headline).toMatch(/^Your passphrase protects key Element security key\./);
    expect(d.headline).toMatch(/Settings → Security & Privacy/);
    expect(d.hasPassphraseDerivedKey).toBe(true);
    expect(d.staleEntries).toBe(false);
    expect(d.notes).toEqual([]);
    expect(d.defaultKeyId).toBe("Bkey1234");
    expect(d.keys).toHaveLength(1);
    expect(d.keys[0].pbkdf2Iterations).toBe(500000);
    expect(d.keys[0].guardsSecrets).toEqual([
      "m.cross_signing.master",
      "m.cross_signing.self_signing",
      "m.cross_signing.user_signing",
      "m.megolm_backup.v1",
    ]);
    expect(d.secrets.every((s) => s.exists)).toBe(true);
    expect(d.backup).toEqual({ exists: true, version: "9", algorithm: "m.megolm.v1.aes-sha2", count: 3 });
    // W17 trap: backup version read via authedRequest with the Method ENUM + string path
    expect(authedCalls).toEqual([{ method: Method.Get, path: "/room_keys/version" }]);
  });

  it("rule 1: no passphrase-derived key -> recovery-key-only headline", async () => {
    const store = mkAccountStore({
      defaultKeyId: "RgenKey1",
      keys: { RgenKey1: { algorithm: AES, name: "Recovery key" } }, // NO passphrase field = generated
      secrets: ALL_SECRETS(["RgenKey1"]),
    });
    const { client } = mkDescClient(store);
    const d = await describeSecurityAccount(client);
    expect(d.headline).toBe(
      "This account has no security passphrase — only a recovery key. Use the recovery key, or reset.",
    );
    expect(d.hasPassphraseDerivedKey).toBe(false);
    expect(d.keys[0].passphraseDerived).toBe(false);
  });

  it("rule 3: secrets missing entirely -> no-cross-signing-secret headline", async () => {
    const store = mkAccountStore({
      defaultKeyId: "Bkey1234",
      keys: { Bkey1234: derivedDesc() },
      secrets: {}, // not one secret stored
    });
    const { client } = mkDescClient(store, new Error("404 not found"));
    const d = await describeSecurityAccount(client);
    expect(d.headline).toMatch(/No cross-signing secret is stored/);
    expect(d.secrets.every((s) => !s.exists)).toBe(true);
    expect(d.backup.exists).toBe(false); // 404 handled, not thrown
  });

  it("W22 multi-entry shape: stale older-key copies -> actionable note alongside the current-key headline", async () => {
    const store = mkAccountStore({
      defaultKeyId: "Bcurrent",
      keys: {
        Aolder9999: { algorithm: AES }, // old generated key, still guarding copies
        Bcurrent: derivedDesc("Element security key"),
      },
      secrets: {
        "m.cross_signing.master": ["Aolder9999", "Bcurrent"],
        "m.cross_signing.self_signing": ["Bcurrent"],
        "m.cross_signing.user_signing": ["Bcurrent"],
        "m.megolm_backup.v1": ["Aolder9999", "Bcurrent"],
      },
    });
    const { client } = mkDescClient(store);
    const d = await describeSecurityAccount(client);
    expect(d.headline).toMatch(/^Your passphrase protects key Element security key\./);
    expect(d.staleEntries).toBe(true);
    expect(d.notes).toHaveLength(1);
    expect(d.notes[0]).toMatch(/protected by an older key.*rotated your keys; the current one should still work/);
    const a = d.keys.find((k) => k.keyId === "Aolder9999");
    expect(a?.guardsSecrets).toEqual(["m.cross_signing.master", "m.megolm_backup.v1"]);
    expect(a?.isDefault).toBe(false);
  });

  it("short-id label when the derived default key carries no name", async () => {
    const store = mkAccountStore({
      defaultKeyId: "nonamesuchlongkeyid",
      keys: { nonamesuchlongkeyid: derivedDesc() },
      secrets: ALL_SECRETS(["nonamesuchlongkeyid"]),
    });
    const { client } = mkDescClient(store);
    const d = await describeSecurityAccount(client);
    expect(d.headline).toContain(`“${"nonamesuchlongkeyid".slice(0, 12)}…”`);
  });

  it("generated DEFAULT key with an older passphrase-derived entry -> fallback headline", async () => {
    const store = mkAccountStore({
      defaultKeyId: "Gnow",
      keys: { Cold: derivedDesc(), Gnow: { algorithm: AES } },
      secrets: ALL_SECRETS(["Gnow"]),
    });
    const { client } = mkDescClient(store);
    const d = await describeSecurityAccount(client);
    expect(d.headline).toMatch(/default key is a generated recovery key/);
    expect(d.hasPassphraseDerivedKey).toBe(true); // one exists, just not the default
  });

  it("degrades to the crypto surface when no http seam exists", async () => {
    const store = mkAccountStore({
      defaultKeyId: "Bkey",
      keys: { Bkey: derivedDesc("k") },
      secrets: ALL_SECRETS(["Bkey"]),
    });
    const client = {
      getAccountDataFromServer: async (t: string) => store.get(t) ?? null,
      getHomeserverUrl: () => "https://hs.test",
      getUserId: () => "@a:hs.test",
      getCrypto: () => ({ getKeyBackupInfo: async () => ({ version: "7", algorithm: AES }) }),
    } as unknown as MatrixClient;
    const d = await describeSecurityAccount(client);
    expect(d.backup).toEqual({ exists: true, version: "7", algorithm: AES, count: null });
  });

  it("server-first reads: local cache is NOT preferred when the server answers", async () => {
    const store = mkAccountStore({ defaultKeyId: "Ssrv", keys: { Ssrv: derivedDesc("srv") }, secrets: ALL_SECRETS(["Ssrv"]) });
    let usedServer = 0;
    const client = {
      getAccountDataFromServer: async (t: string) => {
        usedServer++;
        return store.get(t) ?? null;
      },
      getAccountData: () => ({ getContent: () => ({ key: "LOCALSTALE" }) }),
      getHomeserverUrl: () => "https://hs.test",
      getUserId: () => "@a:hs.test",
      getCrypto: () => null,
      http: { authedRequest: async () => null },
    } as unknown as MatrixClient;
    const d = await describeSecurityAccount(client);
    expect(usedServer).toBeGreaterThan(0);
    expect(d.defaultKeyId).toBe("Ssrv"); // never the stale local default
  });
});

describe("W23-D describeSecurityAccountText", () => {
  it("renders full key ids for support paste — and NEVER ciphertext/iv/mac material", async () => {
    const store = mkAccountStore({
      defaultKeyId: "Bcurrent",
      keys: { Aolder: { algorithm: AES }, Bcurrent: derivedDesc("Element security key") },
      secrets: {
        "m.cross_signing.master": ["Aolder", "Bcurrent"],
        "m.cross_signing.self_signing": ["Bcurrent"],
        "m.cross_signing.user_signing": ["Bcurrent"],
        "m.megolm_backup.v1": ["Aolder", "Bcurrent"],
      },
    });
    const { client } = mkDescClient(store);
    const d = await describeSecurityAccount(client);
    const text = describeSecurityAccountText(d);
    expect(text).toContain("Bcurrent"); // key ids are public account data — full
    expect(text).toContain("Aolder");
    expect(text).toContain("guarded under key id(s): Aolder, Bcurrent");
    expect(text).toContain("version 9");
    expect(text).toContain("Note: Some copies of your secrets are protected by an older key");
    // redaction: the encrypted MAP FIELDS must never be echoed
    expect(text).not.toMatch(/ciphertext|SENTINEL|iv:|mac/i);
  });

  it("states MISSING / NOT stored honestly", async () => {
    const store = mkAccountStore({ defaultKeyId: "Dk", keys: { Dk: derivedDesc() }, secrets: {} });
    const { client } = mkDescClient(store, null);
    const text = describeSecurityAccountText(await describeSecurityAccount(client));
    expect(text).toContain("NOT stored");
    expect(text).toContain("Key backup: none on the server");
  });
});

import type { MatrixClient } from "matrix-js-sdk";
import { decodeRecoveryKey, encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { keyFromAuthData } from "matrix-js-sdk/lib/common-crypto/key-passphrase.js";
import decryptAESSecretStorageItem from "matrix-js-sdk/lib/utils/decryptAESSecretStorageItem.js";
import { SECRET_STORAGE_ALGORITHM_V1_AES } from "matrix-js-sdk/lib/secret-storage.js";

/**
 * Per-client holder for the SSSS private key created mid-bootstrap. js-sdk's
 * cryptoCallbacks.getSecretStorageKey (wired in createClientSession) consults
 * this when 4S immediately encrypts cross-signing secrets into the new key.
 */
const bootstrapKeys = new WeakMap<MatrixClient, Uint8Array<ArrayBuffer>>();
export function rememberBootstrapKey(client: MatrixClient, privateKey: Uint8Array<ArrayBuffer>): void {
  bootstrapKeys.set(client, privateKey);
}
export function getBootstrapKey(client: MatrixClient): Uint8Array<ArrayBuffer> | undefined {
  return bootstrapKeys.get(client);
}

/**
 * W14 per-client holder for a USER-UNLOCKED SSSS key (the unlock-session
 * flow). Same purpose as the bootstrap holder, different origin: the key was
 * derived from the account's EXISTING Secure Secret Storage (passphrase or
 * recovery key), not created mid-bootstrap. cryptoCallbacks.getSecretStorageKey
 * in sdk.ts consults both — without the second source, bootstrapCrossSigning's
 * internal secretStorage.get("m.cross_signing.*") on an account that already
 * has 4S dies at "getSecretStorageKey callback returned falsey" (Sean's real
 * crash; rust-crypto/CrossSigningIdentity.js always tries 4S first).
 */
const unlockedSsssKeys = new WeakMap<MatrixClient, Uint8Array<ArrayBuffer>>();
export function setUnlockedSsssKey(client: MatrixClient, privateKey: Uint8Array<ArrayBuffer>): void {
  unlockedSsssKeys.set(client, privateKey);
}
export function getUnlockedSsssKey(client: MatrixClient): Uint8Array<ArrayBuffer> | undefined {
  return unlockedSsssKeys.get(client);
}

/** Server-side read seam — account data can be missing from the LOCAL cache on
 *  a fresh session (sync hasn't delivered it yet), which made the W21 hotfix
 *  reads flaky. W22: always fetch FROM THE SERVER first; fall back to the
 *  local cache only when the server read is unavailable (offline) or empty. */
async function readAccountData(client: MatrixClient, type: string): Promise<Record<string, unknown> | null> {
  const fn = client.getAccountDataFromServer as unknown as (t: string) => Promise<Record<string, unknown> | null>;
  try {
    const server = await fn.call(client, type);
    if (server) return server;
  } catch {
    // server unreachable — try the local cache below (honest degraded read)
  }
  const local = (
    client.getAccountData as unknown as ((k: string) => { getContent: () => unknown } | undefined) | undefined
  )?.(type)?.getContent?.();
  return (local as Record<string, unknown> | undefined) ?? null;
}

/** The account's default SSSS key id (m.secret_storage.default_key -> content.key). */
export async function defaultSsssKeyId(client: MatrixClient): Promise<string | null> {
  const acct = await readAccountData(client, "m.secret_storage.default_key");
  return (acct?.key as string | undefined) ?? null;
}

/**
 * Pick the advertised key id that our single stored SSSS key belongs to:
 * prefer the account's default key id when it is among `keys`, else the first
 * advertised id. Single-SSSS-key product assumption (same as sdk.ts — re-key
 * flows land later); returning a keyId NOT in `keys` would make js-sdk throw
 * "App returned unknown key from getSecretStorageKey!".
 *
 * W22 NOTE: this only serves the CLIENT-LEVEL cryptoCallbacks.getSecretStorageKey
 * (sdk.ts), where the SDK-internal fetches during bootstrapCrossSigning are
 * inherently single-shot — ServerSideSecretStorageImpl.get() asks the callback
 * ONCE and decrypts ONLY secretInfo.encrypted[keyId] for the returned keyId
 * (secret-storage.js:303, no excludes/retry anywhere). Our own unlock/restore
 * paths therefore bypass sss.get entirely in favour of decryptSecretWithKey,
 * which tries EVERY copy; do NOT try to make the SDK internals retry.
 */
export async function pickSsssKeyId(
  client: MatrixClient,
  keys: Record<string, unknown>,
): Promise<string | undefined> {
  const def = await defaultSsssKeyId(client);
  if (def && keys && Object.prototype.hasOwnProperty.call(keys, def)) return def;
  return Object.keys(keys ?? {})[0];
}

/** Strip ALL whitespace from a user-typed recovery key (copy/paste line wraps,
 *  mobile keyboards). Applied at EVERY core entry point that decodes a key
 *  (W22: the b28e991 hotfix covered only unlockWithSecret). */
export function cleanRecoveryKey(s: string): string {
  return s.replace(/\s+/g, "");
}


/**
 * W22 THE FIX — decrypt `name` from 4S with the given key bytes, trying EVERY
 * key entry the secret is encrypted under, not just one.
 *
 * Real accounts (Element, multi-rotation histories) carry secrets whose
 * `encrypted` map holds STALE entries: {A(old key), B(default key)}. A user who
 * supplies A's key bytes hits the SDK single-shot failure: get() asks the app
 * callback once, pickSsssKeyId answers B (default wins), B's entry is decrypted
 * with A's bytes and throws "bad MAC" even though entry A would succeed.
 *
 * Strategy: read the secret's `encrypted` map FROM THE SERVER, order candidate
 * key ids (default key first when present, then the rest), skip entries we
 * cannot handle (unknown algorithm, missing iv/ciphertext/mac) — they are not
 * fatal — and try each with the SDK's OWN AES-HMAC routine
 * (decryptAESSecretStorageItem, the exact code ServerSideSecretStorageImpl
 * wraps). First success wins; all-fail returns null. NEVER mutates account
 * data or SDK state.
 */
export async function decryptSecretWithKey(
  client: MatrixClient,
  name: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<string | null> {
  const secretInfo = await readAccountData(client, name);
  const map = secretInfo?.encrypted as
    | Record<string, { iv?: string; ciphertext?: string; mac?: string }>
    | undefined;
  if (!map) return null;
  const def = await defaultSsssKeyId(client);
  const ids = Object.keys(map);
  const ordered = def && map[def] ? [def, ...ids.filter((id) => id !== def)] : ids;
  for (const keyId of ordered) {
    const encInfo = map[keyId];
    if (!encInfo?.iv || !encInfo.ciphertext || !encInfo.mac) continue; // malformed entry — skip
    const desc = await readAccountData(client, `m.secret_storage.key.${keyId}`);
    if (desc?.algorithm !== SECRET_STORAGE_ALGORITHM_V1_AES) continue; // unsupported algorithm — skip
    try {
      return await decryptAESSecretStorageItem(
        encInfo as { iv: string; ciphertext: string; mac: string },
        keyBytes,
        name,
      );
    } catch {
      // bad MAC (or AES failure) for THIS copy — the next entry may match
    }
  }
  return null;
}


/**
 * E2EE security lifecycle (PRD §6.4 — the make-or-break surface).
 * Thin, honest orchestration over js-sdk 45 CryptoApi; UI screens call ONLY this.
 */

export interface SecuritySetup {
  /** ONE-TIME-VIEW secret: the UI must force acknowledgment before returning. */
  recoveryKey: string;
}

export interface BackupRestoreProgress {
  total?: number;
  imported?: number;
}

/**
 * Device1 path: create cross-signing identity, 4S/SSSS (passphrase-backed) and
 * server key backup, and hand back the recovery key for the user to save.
 * `password` re-auths the UIA steps (m.login.password — Synapse demands it
 * even for freshly registered tokens).
 */
export async function bootstrapSecurity(opts: {
  client: MatrixClient;
  userId: string;
  password: string;
  passphrase: string;
}): Promise<SecuritySetup> {
  const { client, userId, password, passphrase } = opts;
  if (passphrase.length < 8) throw new Error("passphrase too short (min 8)");
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised — call with an initCrypto session");

  // W14 defense-in-depth: an account that ALREADY has Secure Secret Storage
  // must not be re-bootstrapped here — bootstrapCrossSigning would import
  // from the existing 4S and die at the getSecretStorageKey callback (holder
  // empty -> "callback returned falsey"). The UI routes these cases to
  // unlockWithSecret; this guard protects any caller that misses that branch.
  if (await crypto.isSecretStorageReady()) {
    throw new Error(
      "This account already has Secure Secret Storage — enter your existing passphrase or recovery key to unlock this session instead.",
    );
  }

  try {
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        await makeRequest({
          type: "m.login.password",
          identifier: { type: "m.id.user", user: userId },
          password,
        } as never);
      },
    });
  } catch (err) {
    // 11-24 (Sean prod): accounts created/verified in older Element can carry
    // cross-signing keys WITHOUT 4S — the setup screen then dead-ends with an
    // opaque SDK error. Route the user to what actually works. Wrong-password
    // rejections keep their honest message.
    const m = String((err as Error)?.message ?? err);
    if (/password|forbidden|403|uia|flow/i.test(m)) throw err;
    throw new Error(
      `This account already has encryption keys from another app, so a brand-new passphrase can't be created here. ${m}`,
    );
  }

  const generated = await crypto.createRecoveryKeyFromPassphrase(passphrase);
  rememberBootstrapKey(client, generated.privateKey);
  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: true,
    setupNewKeyBackup: true,
    createSecretStorageKey: async () => generated,
  });

  // both representations of the SAME key: passphrase-derived base64 privateKey +
  // the spec's user-saveable base58 "recovery key" form
  // machine-side enable: creating the version is NOT enough — rust crypto only
  // queues sessions for backup once backup is enabled inside the machine
  // (found on HS-A: sessions silently never uploaded otherwise)
  await crypto.checkKeyBackupAndEnable();

  const recoveryKey = generated.encodedPrivateKey ?? encodeRecoveryKey(generated.privateKey);
  if (!recoveryKey) throw new Error("no recovery key generated");
  return { recoveryKey };
}

/** Wait until the account reports cross-signing + secret storage + a backup version. */
export async function securityReady(client: MatrixClient, ms = 20000): Promise<boolean> {
  const crypto = client.getCrypto();
  if (!crypto) return false;
  const t0 = Date.now();
  for (;;) {
    const [xsign, ssss, backup] = await Promise.all([
      crypto.isCrossSigningReady(),
      crypto.isSecretStorageReady(),
      crypto.getKeyBackupInfo(),
    ]);
    if (xsign && ssss && backup) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Shared passphrase -> SSSS key derivation (W14 extraction — used by
 * restoreBackupWithPassphrase AND unlockWithSecret, identical behavior):
 * read m.secret_storage.default_key, check its description carries a
 * PBKDF2 passphrase spec, then keyFromAuthData with those salt/iterations.
 */
async function deriveSsssKeyFromPassphrase(
  client: MatrixClient,
  passphrase: string,
): Promise<{ keyId: string; key: Uint8Array<ArrayBuffer> }> {
  // W22: read the key description FROM THE SERVER — a fresh session's local
  // account-data cache may not carry it yet (sync race), which made this throw
  // "no default secret storage key configured" on valid passphrases.
  const defaultKeyId = await defaultSsssKeyId(client);
  if (!defaultKeyId) throw new Error("no default secret storage key configured");
  const desc = (await readAccountData(client, "m.secret_storage.key." + defaultKeyId)) as
    | { passphrase?: { algorithm?: string; iterations?: number; salt?: string } }
    | null;
  const p = desc?.passphrase;
  if (!p?.salt || !p.iterations || p.algorithm !== "m.pbkdf2") {
    throw new Error("default SSSS key is not passphrase-derived");
  }
  // PBKDF2 derivation itself: reuse js-sdk's exported helper by mapping the SSSS
  // description onto its (legacy-shaped) authData fields — same algorithm per spec.
  const key = await keyFromAuthData(
    { private_key_salt: p.salt, private_key_iterations: p.iterations, private_key_bits: 256 } as never,
    passphrase,
  );
  return { keyId: defaultKeyId, key: key as Uint8Array<ArrayBuffer> };
}

/**
 * New-device path via SECURITY PASSPHRASE — the proper 4S route (rust
 * backups carry no private_key_salt; js-sdk's own restoreKeyBackupWithPassphrase
 * is legacy libolm-era and fails against them — found on HS-A, 2026-11-19):
 *   passphrase -> deriveSsssKeyFromPassphrase
 *            -> unlock m.megolm_backup.v1 from secret storage
 *            -> store backup key -> restore megolm keys.
 * Returns imported-key count from the final restore.
 */
export async function restoreBackupWithPassphrase(
  client: MatrixClient,
  passphrase: string,
  onProgress?: (p: BackupRestoreProgress) => void,
): Promise<number> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised");
  const info = await crypto.getKeyBackupInfo();
  if (!info) throw new Error("no key backup on server");

  const { key: ssssKey } = await deriveSsssKeyFromPassphrase(client, passphrase);

  // W22: try EVERY copy of the secret, not just the one the SDK's single-shot
  // get() would pick (stale key entries on real accounts caused bad-MAC).
  const b64 = await decryptSecretWithKey(client, "m.megolm_backup.v1", ssssKey);
  if (!b64) throw new Error("backup key not found in secret storage (wrong passphrase?)");
  const backupKey = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await crypto.storeSessionBackupPrivateKey(backupKey, info.version);

  const res = await crypto.restoreKeyBackup({
    progressCallback: (prog: unknown) => {
      const q = prog as { total?: number; imported?: number };
      onProgress?.({ total: q.total, imported: q.imported });
    },
  } as never);
  return res?.total ?? 0;
}

/** Given the SSSS symmetric key bytes, fetch the backup decryption secret from 4S.
 *  W22: routes through decryptSecretWithKey — every encrypted copy is tried. */
async function backupKeyFromSSSS(
  client: MatrixClient,
  ssssKey: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const b64 = await decryptSecretWithKey(client, "m.megolm_backup.v1", ssssKey);
  if (!b64) throw new Error("backup key not found in secret storage");
  return b64;
}

export async function restoreBackupWithRecoveryKey(
  client: MatrixClient,
  recoveryKey: string,
  onProgress?: (p: BackupRestoreProgress) => void,
): Promise<number> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised");
  // the recovery key IS the SSSS key — unlock the backup secret from 4S with it
  // (W22: whitespace normalization here too — b28e991 covered only unlockWithSecret)
  const ssssKey = decodeRecoveryKey(cleanRecoveryKey(recoveryKey)) as Uint8Array<ArrayBuffer>;
  const b64 = await backupKeyFromSSSS(client, ssssKey);
  const info = await crypto.getKeyBackupInfo();
  if (!info) throw new Error("no key backup on server");
  const backupKey = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await crypto.storeSessionBackupPrivateKey(backupKey, info.version);
  const res = await crypto.restoreKeyBackup({
    progressCallback: (p: unknown) => {
      const q = p as { total?: number; imported?: number };
      onProgress?.({ total: q.total, imported: q.imported });
    },
  } as never);
  return res?.total ?? 0;
}

/** The user's secret for the unlock-session flow: EITHER the SSSS passphrase
 *  OR the base58 recovery key. Discriminated by present key. */
export type UnlockSecret = { passphrase: string } | { recoveryKey: string };

/**
 * W14 UNLOCK-SESSION: an account that ALREADY has Secure Secret Storage (set
 * up by Element or another Linnet session — Sean's real case) but a locked
 * fresh session. The old crash path: bootstrapSecurity's
 * bootstrapCrossSigning always calls secretStorage.get("m.cross_signing.*")
 * first; with 4S present the SDK asks our cryptoCallbacks.getSecretStorageKey
 * and — no bootstrap holder key — js-sdk threw
 * "getSecretStorageKey callback returned falsey" (secret-storage.js:374).
 *
 * This flow proves the secret FIRST (decrypt m.cross_signing.master via
 * decryptSecretWithKey — EVERY copy in the 4S `encrypted` map is tried, which
 * is the W22 fix for stale key entries on real Element accounts), then parks
 * the key so the client-level callback serves it, then runs
 * bootstrapCrossSigning({}) which takes rust's import-from-4S branch (signs
 * the local device via the outgoing-request processor — NO UIAA, so no
 * password param), and finally restores the server key backup.
 *
 * Throws "wrong passphrase or recovery key" on any decryption failure of the
 * PROVE step BEFORE mutating anything, and "nothing to unlock — no secrets
 * found in secret storage" when 4S holds neither master secret nor a backup
 * secret. If the SDK's single-shot internal cross-signing import fails after
 * the proof (stale-key accounts — see step 4), the backup restore still runs
 * and the result reports crossSigningImported: false.
 */
export async function unlockWithSecret(opts: {
  client: MatrixClient;
  secret: UnlockSecret;
  onProgress?: (p: BackupRestoreProgress) => void;
}): Promise<{ imported: number; crossSigningImported: boolean }> {
  const { client, secret, onProgress } = opts;
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised — call with an initCrypto session");

  // 1) derive the candidate SSSS key bytes from whatever the user typed
  let key: Uint8Array<ArrayBuffer>;
  if ("passphrase" in secret && typeof secret.passphrase === "string") {
    key = (await deriveSsssKeyFromPassphrase(client, secret.passphrase)).key;
  } else if ("recoveryKey" in secret && typeof secret.recoveryKey === "string") {
    // Sean prod report (11-24): keys re-typed/copied from Element arrive with
    // stray whitespace or the occasional typo, and the SDK's raw
    // "Incorrect parity" surfaced verbatim — normalize first, then turn
    // format failures into actionable copy.
    const cleaned = cleanRecoveryKey(secret.recoveryKey);
    try {
      key = decodeRecoveryKey(cleaned) as Uint8Array<ArrayBuffer>;
    } catch (err) {
      const m = String((err as Error)?.message ?? err);
      if (/non-base58|invalid character|base58/i.test(m)) {
        throw new Error("That doesn't look like a recovery key. The format is groups of 4 characters starting with E (no 0, O, I or l). If you copied an OLD Element backup key (one long word starting with a lowercase letter), use your security passphrase instead.");
      }
      throw new Error("That recovery key failed its checksum — re-copy it from Element (Settings → Security & Privacy → Recovery Key) without typos or extra characters.");
    }
  } else {
    throw new Error("unlock: provide a passphrase or a recovery key");
  }

  // 2) PROVE the secret before mutating anything: decrypt the cross-signing
  //    master secret (W22: decryptSecretWithKey tries EVERY copy of the secret
  //    in the 4S `encrypted` map — the SDK single-shot get() failed on real
  //    accounts carrying stale key entries, Sean's prod report: both the
  //    passphrase AND the recovery key threw "bad MAC"). Null = no copy
  //    decrypted = wrong secret.
  const master = await decryptSecretWithKey(client, "m.cross_signing.master", key);
  if (!master) {
    // no master secret decryptable in 4S: accept a successful backup-secret
    // fetch when a key backup exists; otherwise there is nothing this flow
    // can restore.
    const hasBackup = Boolean(await crypto.getKeyBackupInfo());
    if (!hasBackup) throw new Error("nothing to unlock — no secrets found in secret storage");
    const backupSecret = await decryptSecretWithKey(client, "m.megolm_backup.v1", key);
    if (!backupSecret) throw new Error("wrong passphrase or recovery key");
  }

  // 3) from here on the client-level callback serves the key — this is what
  //    makes bootstrapCrossSigning's internal secretStorage.get succeed.
  setUnlockedSsssKey(client, key);

  // importCrossSigningKeys fails SILENTLY unless the machine already knows the
  // cross-signing PUBLIC keys; a locked device that has joined no rooms yet
  // has nobody to trigger /keys/query — force one for our own user first
  // (rust feeds the response into the machine via the outgoing-request
  // processor).
  const me = client.getUserId();
  if (me) await crypto.getUserDeviceInfo([me], true);

  // 4) import the cross-signing identity from 4S into this device (no UIAA on
  //    the import branch: device signing rides the outgoing-request processor).
  //
  //    W22: this call's internal secretStorage.get() is SINGLE-SHOT (see the
  //    limitation documented in sdk.ts): on an account whose cross-signing
  //    secrets ONLY carry current-key entries, a stale-but-valid key (proven
  //    against the backup secret above) cannot drive that import and the SDK
  //    throws "bad MAC". Never leak the raw string; the user's history is
  //    still recoverable, so continue to step 5 and report the partial result
  //    via crossSigningImported=false. Wrong-password/UIA rejections stay
  //    honest and propagate verbatim (b28e991 rule).
  let crossSigningImported = true;
  try {
    await crypto.bootstrapCrossSigning({});
  } catch (err) {
    const m = String((err as Error)?.message ?? err);
    if (/password|forbidden|403|uia|flow/i.test(m)) throw err;
    if (!/bad MAC|could not decrypt|returned falsey|unknown key/i.test(m)) throw err;
    crossSigningImported = false;
  }

  // 5) key backup restore. HS-A-proven (W14): js-sdk 45 restoreKeyBackup only
  //    decrypts with a backup key CACHED in the machine — rust-crypto.ts:1511
  //    throws "No decryption key found in crypto store" otherwise — so feed it
  //    from 4S first, exactly like restoreBackupWithPassphrase does. If no
  //    backup exists at all, there is nothing to restore (imported 0).
  let imported = 0;
  const info = await crypto.getKeyBackupInfo();
  if (info) {
    // W22: multi-copy fetch — same stale-entry failure shape applies here.
    const b64 = await decryptSecretWithKey(client, "m.megolm_backup.v1", key);
    if (b64) {
      const backupKey = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await crypto.storeSessionBackupPrivateKey(backupKey, info.version);
    }
    await crypto.checkKeyBackupAndEnable();
    const res = await crypto.restoreKeyBackup({
      progressCallback: (p: unknown) => {
        const q = p as { total?: number; imported?: number };
        onProgress?.({ total: q.total, imported: q.imported });
      },
    } as never);
    imported = res?.total ?? 0;
  }
  return { imported, crossSigningImported };
}

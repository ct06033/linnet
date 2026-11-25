import type { MatrixClient } from "matrix-js-sdk";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
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
 * W24 extraction (shared by unlockWithSecret AND rotateRecoveryMethod):
 * derive candidate SSSS key BYTES from whatever the user typed. Passphrase →
 * PBKDF2 against the account's default-key description (server-first reads);
 * recovery key → whitespace-normalized base58 decode with actionable copy for
 * format failures (Sean prod report 11-24: the raw "Incorrect parity" leaked
 * verbatim pre-b28e991).
 */
async function deriveCandidateKey(client: MatrixClient, secret: UnlockSecret): Promise<Uint8Array<ArrayBuffer>> {
  if ("passphrase" in secret && typeof secret.passphrase === "string") {
    return (await deriveSsssKeyFromPassphrase(client, secret.passphrase)).key;
  }
  if ("recoveryKey" in secret && typeof secret.recoveryKey === "string") {
    const cleaned = cleanRecoveryKey(secret.recoveryKey);
    try {
      return decodeRecoveryKey(cleaned) as Uint8Array<ArrayBuffer>;
    } catch (err) {
      const m = String((err as Error)?.message ?? err);
      if (/non-base58|invalid character|base58/i.test(m)) {
        throw new Error("That doesn't look like a recovery key. The format is groups of 4 characters starting with E (no 0, O, I or l). If you copied an OLD Element backup key (one long word starting with a lowercase letter), use your security passphrase instead.");
      }
      throw new Error("That recovery key failed its checksum — re-copy it from Element (Settings → Security & Privacy → Recovery Key) without typos or extra characters.");
    }
  }
  throw new Error("unlock: provide a passphrase or a recovery key");
}

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
  const key = await deriveCandidateKey(client, secret);

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

// ---------------------------------------------------------------------------
// W23 route B — DESTRUCTIVE "Reset security access" for the locked-out
// account (forgot passphrase AND lost recovery key). This is NOT a recovery:
// nothing protected by the old SSSS comes back — the flow rotates everything
// and hands the user a brand-new recovery key.
//
// Verified against the INSTALLED matrix-js-sdk@45.1.0 .d.ts + rust-crypto.js
// (Rule 1 — the wave spec's "expected shape" was wrong in two ways):
//   * CryptoApi.bootstrapSecretStorage(CreateSecretStorageOpts) — 45.1's
//     CreateSecretStorageOpts is { createSecretStorageKey?, setupNewSecretStorage?,
//     setupNewKeyBackup? }. There is NO authQueries field anywhere in this
//     version; SSSS rotation is plain account-data writes and carries NO UIA.
//     The UIA surface of this flow is the cross-signing upload below.
//   * CryptoApi.bootstrapCrossSigning({ setupNewCrossSigning: true,
//     authUploadDeviceSigningKeys }) — rust's resetCrossSigning() creates NEW
//     identity keys (old cached private keys are irrelevant), exports the
//     private keys into the (already-rotated) 4S, and publishes via
//     makeOutgoingRequest(request, authUploadDeviceSigningKeys) — POST
//     /keys/device_signing/upload is UIA-gated: the payload MUST carry
//     identifier {type:"m.id.user", user} (W5a trap: without it Synapse
//     answers M_INVALID_PARAM).
//   * CryptoApi.resetKeyBackup() — internally backupManager.setupKeyBackup():
//     deleteAllKeyBackupVersions() FIRST (old server backup gone — the wave
//     spec's "delete old backup then recreate" is one verified call, no
//     /room_keys DELETE plumbing needed; 45.1 does NOT UIA-gate room_keys
//     version create/delete), creates + signs a NEW version with the new
//     identity, enables the machine backup engine, saves the new decryption
//     key locally AND stores it in 4S (secretStorageHasAESKey is now true).
//
// Order matters (wave spec): rotate SSSS FIRST, THEN cross-signing (the new
// private keys must land under the new key), THEN backup (the new backup key
// too). There is NO public "upload all sessions now" API in 45.1 — the rust
// engine re-queues local sessions when the new backup switches on
// (enableOrSwitchKeyBackup inside setupKeyBackup + checkKeyBackupAndEnable
// as belt-and-braces, the W14 machine-side lesson); a key landing in the new
// backup is PROVEN by the live HS-A test, not assumed.
//
// Honesty (b28e991 rule): NOTHING is wrapped here. Wrong-password / UIA 403 /
// M_INVALID_PARAM propagate verbatim to the caller; the UI maps only the
// decryption-error family (mapSecretStorageError).

export interface SecurityReset {
  /** ONE-TIME-VIEW secret: the new base58 recovery key for the fresh 4S key. */
  recoveryKey: string;
}

export async function resetSecurityAccess(opts: {
  client: MatrixClient;
  userId: string;
  /** account login password — re-auths the UIA-gated cross-signing upload */
  password: string;
  /** the NEW security passphrase the user chooses (min 8, enforced here) */
  passphrase: string;
  /** handed the recovery key as soon as the rotation itself succeeds — lets
   *  the UI show the forced-ack key view even if a later step fails */
  onKey?: (recoveryKey: string) => void;
}): Promise<SecurityReset> {
  const { client, userId, password, passphrase, onKey } = opts;
  if (passphrase.length < 8) throw new Error("passphrase too short (min 8)");
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised — call with an initCrypto session");

  // 1) SSSS rotation FIRST: a NEW passphrase-derived key becomes the default.
  //    Seed the bootstrap holder so sdk.ts's client-level getSecretStorageKey
  //    callback serves it the moment the SDK starts storing secrets under it.
  const generated = await crypto.createRecoveryKeyFromPassphrase(passphrase);
  rememberBootstrapKey(client, generated.privateKey);
  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: true,
    createSecretStorageKey: async () => generated,
    // setupNewKeyBackup deliberately NOT set — step 3 owns the backup, after
    // the new identity exists so the new backup gets signed with it.
  });

  const recoveryKey = generated.encodedPrivateKey ?? encodeRecoveryKey(generated.privateKey);
  if (!recoveryKey) throw new Error("no recovery key generated");
  onKey?.(recoveryKey);

  // 2) NEW cross-signing identity. setupNewCrossSigning:true FORCES fresh keys
  //    (the wave spec rule: old cached private cross-signing keys are gone —
  //    without forcing, the import-from-4S branch would fail). The UIA request
  //    happens inside; a wrong password rejects here with the server's own
  //    message, unmodified.
  await crypto.bootstrapCrossSigning({
    setupNewCrossSigning: true,
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password,
      } as never);
    },
  });

  // 3) Backup: delete-all-old + create-new + sign-with-new-identity + enable
  //    engine + store new key in the new 4S (all inside resetKeyBackup per the
  //    45.1 source), then the W14 machine-side enable insurance.
  await crypto.resetKeyBackup();
  await crypto.checkKeyBackupAndEnable();

  return { recoveryKey };
}

// ---------------------------------------------------------------------------
// W24 ROUTE E — ROTATE RECOVERY METHOD (Sean's exact flow, NON-DESTRUCTIVE):
// prove the CURRENT credential (recovery key OR passphrase — same door), set
// a NEW passphrase, Linnet DECRYPTS HISTORY NOW and the new passphrase is the
// credential for FUTURE logins. The cross-signing IDENTITY IS PRESERVED: this
// flow NEVER calls setupNewCrossSigning, needs NO UIA and NO account password.
//
// Verified against the INSTALLED matrix-js-sdk@45.1.0 sources (Rule 1):
//   * rust-crypto.js:726 bootstrapSecretStorage({setupNewSecretStorage:true,
//     createSecretStorageKey}) only ADDS the new key (addKey + setDefaultKeyId
//     + cacheSecretStorageKey callback). It re-stores the cross-signing
//     secrets ONLY IF THIS MACHINE caches their private keys
//     (olmMachine.exportCrossSigningKeys()), and the backup key ONLY via
//     saveBackupKeyToStorage() when the machine caches a decryption key that
//     MATCHES the current backup version. On the locked-out/rotating device
//     (fresh login, nothing imported) neither holds — so Linnet MUST re-wrap
//     every secret it decrypted in the proof step itself. The LIVE test is
//     the arbiter: it asserts the new default key decrypts every secret.
//   * secret-storage.js:249 store() REPLACES the whole `encrypted` map with
//     the single entry under the current default key — re-wrapping therefore
//     RETIRES the old credential for 4S fetches automatically (the brief's
//     "K1 stops working"), with no explicit delete of old entries.
//   * CrossSigningIdentity.js bootstrapCrossSigning WITHOUT setupNewCrossSigning
//     takes the import-from-4S branch (get m.cross_signing.* via the SDK's
//     single-shot callback + importCrossSigningKeys) — the identity-stays-
//     identical requirement. setupNewCrossSigning is the W23-B destructive
//     path; it MUST NEVER appear here (the unit tests assert the opts passed).
//
// Order (brief): proof-decrypt (READS ONLY) precedes every account-data
// WRITE; a failed proof mutates NOTHING (the standing no-mutation rule).

export interface SecurityRotation {
  /** ONE-TIME-VIEW secret: base58 of the NEW passphrase-derived key — what
   *  Element's "show recovery key" will show from now on. */
  recoveryKey: string;
  /** megolm keys restored from the (unchanged) server backup on THIS device */
  imported: number;
  /** false = edge H (master secret was not in 4S) or the documented
   *  single-shot import failure — history still works, device stays unverified */
  crossSigningImported: boolean;
  /** false = edge H: the cross-signing MASTER secret was not (decryptably)
   *  stored in 4S — rotation still completes; UI shows the verify-elsewhere copy */
  masterSecretWasStored: boolean;
}

/** the four secrets Linnet knows how to re-wrap, in brief order */
const ROTATE_SECRET_NAMES = [
  "m.cross_signing.master",
  "m.cross_signing.self_signing",
  "m.cross_signing.user_signing",
  "m.megolm_backup.v1",
] as const;

export async function rotateRecoveryMethod(opts: {
  client: MatrixClient;
  userId: string;
  /** proof: EITHER the current recovery key OR the current passphrase */
  secret: UnlockSecret;
  /** the NEW security passphrase (min 8, enforced here) */
  newPassphrase: string;
  /** handed the new recovery key as soon as the rotation commits — lets the
   *  UI force-acknowledge it even if a later step fails */
  onKey?: (recoveryKey: string) => void;
  onProgress?: (p: BackupRestoreProgress) => void;
}): Promise<SecurityRotation> {
  const { client, userId, secret, newPassphrase, onKey, onProgress } = opts;
  if (newPassphrase.length < 8) throw new Error("passphrase too short (min 8)");
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised — call with an initCrypto session");

  // 1) PROVE (reads only): derive candidate bytes from the typed secret —
  //    whitespace-normalized exactly like unlockWithSecret (same helper) —
  //    then decrypt every secret we know with them. ANY decryptable proof is
  //    OK; nothing decryptable → actionable reject, NO mutation anywhere.
  const oldKey = await deriveCandidateKey(client, secret);
  const decrypted = new Map<string, string>();
  for (const name of ROTATE_SECRET_NAMES) {
    const value = await decryptSecretWithKey(client, name, oldKey);
    if (value !== null) decrypted.set(name, value);
  }
  if (decrypted.size === 0) throw new Error("wrong passphrase or recovery key");

  // 2) EDGE H detection: master (decryptably) present in 4S?
  const masterSecretWasStored = decrypted.has("m.cross_signing.master");

  // 3) NEW PASSPHRASE -> new PBKDF2-derived SSSS key (the SDK builds the exact
  //    m.pbkdf2 keyInfo itself — same pattern as bootstrapSecurity/
  //    resetSecurityAccess). Seed BOTH client-level holders NOW so every SDK
  //    callback (addKey caching, our own stores, the later import) serves the
  //    new key — a stale unlocked-holder key (user unlocked this device with
  //    the old secret before rotating) must never encrypt under the new id.
  const generated = await crypto.createRecoveryKeyFromPassphrase(newPassphrase);
  rememberBootstrapKey(client, generated.privateKey);
  setUnlockedSsssKey(client, generated.privateKey);

  // 4) ROTATE 4S: publish the new key + make it the default. NO
  //    setupNewKeyBackup — the server backup version and its keys are the
  //    user's history; rotation must not touch them.
  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: true,
    createSecretStorageKey: async () => generated,
  });

  // RE-WRAP: store every secret proven in step 1 under the new default key.
  // On a locked device bootstrapSecretStorage does NOT do this itself (see
  // the 45.1 findings above); where it did (machine-cached keys), these
  // stores are harmless idempotent overwrites. store() replaces each
  // `encrypted` map, retiring the old credential for 4S fetches.
  const sss = client.secretStorage;
  for (const [name, value] of decrypted) {
    await sss.store(name as never, value);
  }

  const recoveryKey = generated.encodedPrivateKey ?? encodeRecoveryKey(generated.privateKey);
  if (!recoveryKey) throw new Error("no recovery key generated");
  onKey?.(recoveryKey);

  // 5) UNLOCK THIS DEVICE with the new key — the exact proven
  //    unlockWithSecret step 3-5 pattern: holders are set (step 3 above),
  //    FORCE the public-keys query FIRST (W14 trap: importCrossSigningKeys
  //    fails silently without them), then bootstrapCrossSigning({}) —
  //    IMPORT branch, never setupNewCrossSigning — then the backup side.
  //    (edge H: with no master secret there is nothing to import — skip the
  //    whole cross-signing leg, keys-query included.)
  let crossSigningImported = true;
  if (masterSecretWasStored) {
    const me = client.getUserId() ?? userId;
    if (me) await crypto.getUserDeviceInfo([me], true);
    try {
      await crypto.bootstrapCrossSigning({});
    } catch (err) {
      const m = String((err as Error)?.message ?? err);
      if (/password|forbidden|403|uia|flow/i.test(m)) throw err;
      if (!/bad MAC|could not decrypt|returned falsey|unknown key/i.test(m)) throw err;
      crossSigningImported = false;
    }
  } else {
    // edge H: nothing to import — completing the rotation is non-fatal; the
    // UI explains how to verify this device another way.
    crossSigningImported = false;
  }

  let imported = 0;
  const info = await crypto.getKeyBackupInfo();
  if (info) {
    const b64 = decrypted.get("m.megolm_backup.v1");
    if (b64) {
      // HS-A-proven (W14): restoreKeyBackup only decrypts with the backup key
      // CACHED in the machine — feed it from the re-wrapped 4S secret first.
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

  return { recoveryKey, imported, crossSigningImported, masterSecretWasStored };
}

// ---------------------------------------------------------------------------
// W23 route D — "What your account actually has" diagnostics. SERVER-SIDE
// reads (W22 readAccountData pattern — a fresh session's local cache can lag),
// plain-object return, NO secret values ever. Key ids are public account data
// and shown in full; ciphertext/iv/mac fields are never copied out of the
// encrypted maps (only their key-id index is read).

export interface SecurityAccountKeyInfo {
  keyId: string;
  isDefault: boolean;
  algorithm: string | null;
  name: string | null;
  passphraseDerived: boolean;
  pbkdf2Iterations: number | null;
  /** names of the known secrets that carry an encrypted copy under this key */
  guardsSecrets: string[];
}

export interface SecurityAccountSecretInfo {
  name: string;
  exists: boolean;
  /** key ids whose copies guard this secret (from its `encrypted` map) */
  keyIds: string[];
}

export interface SecurityAccountBackupInfo {
  exists: boolean;
  version: string | null;
  algorithm: string | null;
  count: number | null;
}

export interface SecurityAccountDescription {
  homeserver: string;
  userId: string | null;
  defaultKeyId: string | null;
  keys: SecurityAccountKeyInfo[];
  /** the four 4S secrets Linnet knows about, in spec order */
  secrets: SecurityAccountSecretInfo[];
  backup: SecurityAccountBackupInfo;
  hasPassphraseDerivedKey: boolean;
  /** some secret copy is guarded by a NON-default key id (W22 stale shape) */
  staleEntries: boolean;
  /** actionable head-line, mapped by the W23-D rules */
  headline: string;
  notes: string[];
}

const SECURITY_SECRET_NAMES = [
  "m.cross_signing.master",
  "m.cross_signing.self_signing",
  "m.cross_signing.user_signing",
  "m.megolm_backup.v1",
] as const;

export async function describeSecurityAccount(client: MatrixClient): Promise<SecurityAccountDescription> {
  const defaultKeyId = await defaultSsssKeyId(client);

  const secrets: SecurityAccountSecretInfo[] = [];
  const keyIds = new Set<string>(defaultKeyId ? [defaultKeyId] : []);
  for (const name of SECURITY_SECRET_NAMES) {
    const ev = await readAccountData(client, name);
    const enc = ev?.encrypted as Record<string, unknown> | undefined;
    const ids = Object.keys(enc ?? {});
    for (const id of ids) keyIds.add(id);
    secrets.push({ name, exists: ids.length > 0, keyIds: ids });
  }
  // "every m.secret_storage.key.*": Synapse offers no list endpoint for
  // account-data TYPES, so beyond the default + guarding ids we best-effort
  // enumerate the LOCAL sync cache (client.store.accountData, duck-typed —
  // stub.d.ts declares `readonly accountData: Map<any, any>`). Descriptions
  // are still read server-first per id below; unknown-only-remote keys simply
  // stay unlisted on a cache-empty session (honest degraded view).
  const localStore = (
    client as unknown as { store?: { accountData?: Map<string, unknown> } }
  ).store?.accountData;
  if (localStore instanceof Map) {
    for (const type of localStore.keys()) {
      if (typeof type === "string" && type.startsWith("m.secret_storage.key.")) {
        keyIds.add(type.slice("m.secret_storage.key.".length));
      }
    }
  }

  const keys: SecurityAccountKeyInfo[] = [];
  for (const keyId of keyIds) {
    const desc = await readAccountData(client, `m.secret_storage.key.${keyId}`);
    const p = desc?.passphrase as { algorithm?: string; iterations?: number; salt?: string } | undefined;
    const passphraseDerived = Boolean(p?.salt && p.algorithm === "m.pbkdf2");
    keys.push({
      keyId,
      isDefault: keyId === defaultKeyId,
      algorithm: (desc?.algorithm as string | undefined) ?? null,
      name: (desc?.name as string | undefined) ?? null,
      passphraseDerived,
      pbkdf2Iterations: passphraseDerived ? (p?.iterations ?? null) : null,
      guardsSecrets: secrets.filter((s) => s.keyIds.includes(keyId)).map((s) => s.name),
    });
  }

  // Backup version: GET /room_keys/version via client.http.authedRequest —
  // W17 trap: the Method ENUM (not a bare string), path as string. Degrade to
  // the crypto surface's cached info when no http seam is available.
  let backup: SecurityAccountBackupInfo = { exists: false, version: null, algorithm: null, count: null };
  try {
    const http = (
      client as unknown as {
        http?: { authedRequest?: <T>(method: Method, path: string, q?: undefined, b?: undefined) => Promise<T> };
      }
    ).http;
    let info: Record<string, unknown> | null = null;
    if (http?.authedRequest) {
      info = await http.authedRequest<Record<string, unknown> | null>(Method.Get, "/room_keys/version");
    } else {
      info = (await client.getCrypto()?.getKeyBackupInfo()) as Record<string, unknown> | null;
    }
    const version = typeof info?.version === "string" ? info.version : null;
    if (version) {
      const rawCount = info?.count ?? info?.total;
      backup = {
        exists: true,
        version,
        algorithm: typeof info?.algorithm === "string" ? info.algorithm : null,
        count: typeof rawCount === "number" ? rawCount : null,
      };
    }
  } catch {
    // no backup on the server (404) or unreachable — report it absent honestly
  }

  const master = secrets.find((s) => s.name === "m.cross_signing.master");
  const hasPassphraseDerivedKey = keys.some((k) => k.passphraseDerived);
  const def = keys.find((k) => k.isDefault);
  const staleEntries = secrets.some((s) => s.keyIds.some((id) => id !== defaultKeyId));

  // Head-line mapping (W23-D rules, priority order):
  let headline: string;
  if (keys.length === 0 || !master?.exists) {
    headline =
      "No cross-signing secret is stored — recovery from this account's 4S is impossible; resetting or another session are the paths.";
  } else if (!hasPassphraseDerivedKey) {
    headline =
      "This account has no security passphrase — only a recovery key. Use the recovery key, or reset.";
  } else if (def?.passphraseDerived) {
    const label = def.name && def.name.trim() ? def.name.trim() : `“${def.keyId.slice(0, 12)}…”`;
    headline = `Your passphrase protects key ${label}. If it was made in Element, it is what Element asks for under Settings → Security & Privacy.`;
  } else {
    headline =
      "This account's current default key is a generated recovery key (no passphrase). Use the recovery key, or reset.";
  }

  const notes: string[] = [];
  if (staleEntries) {
    notes.push(
      "Some copies of your secrets are protected by an older key — recent Element changes rotated your keys; the current one should still work.",
    );
  }

  return {
    homeserver: client.getHomeserverUrl?.() ?? "",
    userId: client.getUserId?.() ?? null,
    defaultKeyId,
    keys,
    secrets,
    backup,
    hasPassphraseDerivedKey,
    staleEntries,
    headline,
    notes,
  };
}

/** Plain-text rendering of a SecurityAccountDescription for "Copy details"
 *  (support paste). Key ids are PUBLIC account data — shown in full. Never
 *  includes ciphertext/iv/mac fields or any secret value. */
export function describeSecurityAccountText(d: SecurityAccountDescription): string {
  const lines: string[] = [];
  lines.push("Linnet — what your account has (no secret values)");
  lines.push(`User: ${d.userId ?? "?"} @ ${d.homeserver || "?"}`);
  lines.push(`Headline: ${d.headline}`);
  for (const n of d.notes) lines.push(`Note: ${n}`);
  lines.push(`Default security key: ${d.defaultKeyId ?? "(none)"}`);
  lines.push("Security keys:");
  if (!d.keys.length) lines.push("  (none on this account)");
  for (const k of d.keys) {
    const kind = k.passphraseDerived
      ? `passphrase-derived (pbkdf2, iterations: ${k.pbkdf2Iterations ?? "?"})`
      : "generated recovery key";
    lines.push(
      `  - ${k.keyId}${k.isDefault ? " [default]" : ""} | algorithm: ${k.algorithm ?? "?"} | name: ${k.name ?? "(none)"} | ${kind} | guards: ${k.guardsSecrets.length ? k.guardsSecrets.join(", ") : "(nothing)"}`,
    );
  }
  lines.push("Secrets in 4S:");
  for (const s of d.secrets) {
    lines.push(`  - ${s.name}: ${s.exists ? `stored, guarded under key id(s): ${s.keyIds.join(", ")}` : "NOT stored"}`);
  }
  lines.push(
    d.backup.exists
      ? `Key backup: version ${d.backup.version} (${d.backup.algorithm ?? "algorithm?"}), ${d.backup.count ?? "?"} keys backed up`
      : "Key backup: none on the server",
  );
  return lines.join("\n");
}

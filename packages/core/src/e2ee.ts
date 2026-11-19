import type { MatrixClient } from "matrix-js-sdk";
import { decodeRecoveryKey, encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { keyFromAuthData } from "matrix-js-sdk/lib/common-crypto/key-passphrase.js";
import { ServerSideSecretStorageImpl } from "matrix-js-sdk/lib/secret-storage.js";

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

  await crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password,
      } as never);
    },
  });

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
 * New-device path via SECURITY PASSPHRASE — the proper 4S route, NOT the
 * deprecated keyFromAuthData shortcut (rust backups carry no private_key_salt;
 * js-sdk's own restoreKeyBackupWithPassphrase is legacy libolm-era and fails
 * against them — found on HS-A, 2026-11-19):
 *   passphrase -> PBKDF2 w/ the SSSS key description's salt/iterations
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

  const acct = (t: string) =>
    (client.getAccountData as unknown as (k: string) => { getContent: () => unknown } | undefined)(t)?.getContent();
  const defaultKeyId = (acct("m.secret_storage.default_key") as { key?: string } | undefined)?.key;
  if (!defaultKeyId) throw new Error("no default secret storage key configured");
  const desc = acct("m.secret_storage.key." + defaultKeyId) as
    | { algorithm?: string; passphrase?: { algorithm?: string; iterations?: number; salt?: string } }
    | undefined;
  const p = desc?.passphrase;
  if (!p?.salt || !p.iterations || p.algorithm !== "m.pbkdf2") {
    throw new Error("default SSSS key is not passphrase-derived");
  }
  // PBKDF2 derivation itself: reuse js-sdk's exported helper by mapping the SSSS
  // description onto its (legacy-shaped) authData fields — same algorithm per spec.
  const ssssKey = await keyFromAuthData(
    { private_key_salt: p.salt, private_key_iterations: p.iterations, private_key_bits: 256 } as never,
    passphrase,
  );

  const sss = new ServerSideSecretStorageImpl(client as never, {
    getSecretStorageKey: async () => [defaultKeyId, ssssKey as Uint8Array<ArrayBuffer>],
  });
  const b64 = await sss.get("m.megolm_backup.v1" as never);
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

/** Given the SSSS symmetric key bytes, fetch the backup decryption secret from 4S. */
async function backupKeyFromSSSS(
  client: MatrixClient,
  ssssKey: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const sss = new ServerSideSecretStorageImpl(client as never, {
    getSecretStorageKey: async () => {
      const keyId = await sss0(client);
      return keyId ? [keyId, ssssKey] : null;
    },
  });
  const b64 = await sss.get("m.megolm_backup.v1" as never);
  if (!b64) throw new Error("backup key not found in secret storage");
  return b64;
}
async function sss0(client: MatrixClient): Promise<string | null> {
  const acct = (client.getAccountData as unknown as (k: string) => { getContent: () => unknown } | undefined)("m.secret_storage.default_key")?.getContent() as { key?: string } | undefined;
  return acct?.key ?? null;
}

export async function restoreBackupWithRecoveryKey(
  client: MatrixClient,
  recoveryKey: string,
  onProgress?: (p: BackupRestoreProgress) => void,
): Promise<number> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("crypto not initialised");
  // the recovery key IS the SSSS key — unlock the backup secret from 4S with it
  const ssssKey = decodeRecoveryKey(recoveryKey) as Uint8Array<ArrayBuffer>;
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

/**
 * Matrix encrypted file attachments ("A2HS" scheme, matrix-encryptor parity).
 * Spec shape (docs "Encrypting attachments"):
 *   file: { url, key: JWK(A256CTR, k=raw key b64), iv, hashes: {sha256: hash OF
 *   THE CIPHERTEXT}, v: "v2" }
 * AES-256-CTR; the 16-byte IV doubles as the counter block with the low 64 bits
 * incrementing per block (WebCrypto/OpenSSL increments before the first block —
 * matrix-js-sdk passes the raw IV with length:64, so we match exactly).
 * Verification: SHA-256 over ciphertext BEFORE decrypt. Pure WebCrypto.
 */

export interface EncryptedFileKey {
  kty: "oct";
  key_ops: string[];
  alg: "A256CTR";
  k: string; // unpadded base64 of the raw 32-byte key
  ext: true;
}

export interface EncryptedFileInfo {
  url: string; // mxc://
  key: EncryptedFileKey;
  iv: string; // 16-byte unpadded base64
  hashes: { sha256: string };
  v: "v2";
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function fromB64(s: string): Uint8Array {
  // JWK fields are base64url (per RFC 7515); b64 in hashes/iv is classic.
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  const bin = atob(std + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256B64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return toB64(new Uint8Array(digest));
}

function ctrParams(ivB64: string): { name: "AES-CTR"; counter: ArrayBuffer; length: 64 } {
  return {
    name: "AES-CTR" as const,
    counter: fromB64(ivB64) as unknown as ArrayBuffer,
    length: 64,
  };
}

export async function encryptFile(
  data: Uint8Array,
): Promise<{ info: Omit<EncryptedFileInfo, "url">; ciphertext: Uint8Array }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "AES-CTR" },
    true,
    ["encrypt", "decrypt"],
  );
  const cipherBuf = await crypto.subtle.encrypt(ctrParams(toB64(iv)), key, data as unknown as ArrayBuffer);
  const ciphertext = new Uint8Array(cipherBuf);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as unknown as EncryptedFileKey;
  return {
    ciphertext,
    info: {
      key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: jwk.k, ext: true },
      iv: toB64(iv),
      hashes: { sha256: await sha256B64(ciphertext) }, // spec: hash of CIPHERTEXT
      v: "v2",
    },
  };
}

/** Verifies the SHA-256 of the ciphertext (spec-mandated) then decrypts. */
export async function decryptFile(ciphertext: Uint8Array, info: EncryptedFileInfo): Promise<Uint8Array> {
  const digest = await sha256B64(ciphertext);
  if (digest !== info.hashes.sha256) {
    throw new Error("decryptFile: SHA-256 mismatch (corrupt or wrong key)");
  }
  const keyBytes = fromB64(info.key.k);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as ArrayBuffer,
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );
  const plainBuf = await crypto.subtle.decrypt(ctrParams(info.iv), key, ciphertext as unknown as ArrayBuffer);
  return new Uint8Array(plainBuf);
}

/** Convert mxc://server/id to a download endpoint URL. */
export function mxcToDownloadUrl(homeserverUrl: string, mxc: string, prefix = "/_matrix/client/v1/media/download/"): string {
  const rest = mxc.replace(/^mxc:\/\//, "").replace(/^content:\/\//, "");
  return `${homeserverUrl}${prefix}${rest}`;
}

/** Fetch (authenticated) + verify + decrypt a content object carrying `file`. */
export async function downloadEncryptedMedia(
  content: Record<string, unknown>,
  fetchFn: typeof fetch,
  homeserverUrl: string,
  accessToken: string,
): Promise<Uint8Array> {
  const info = content["file"] as EncryptedFileInfo | undefined;
  if (!info?.url || !info.key) throw new Error("not an encrypted attachment");
  const res = await fetchFn(mxcToDownloadUrl(homeserverUrl, info.url), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return decryptFile(buf, info);
}

/** Fetch (authenticated) plaintext media bytes. */
export async function downloadMedia(
  mxc: string,
  fetchFn: typeof fetch,
  homeserverUrl: string,
  accessToken: string,
): Promise<Uint8Array> {
  const res = await fetchFn(mxcToDownloadUrl(homeserverUrl, mxc), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

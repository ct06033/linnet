# W23 — locked-out UX (routes A, B, D) — and why route C is parked

Stacked on the W22 SSSS-fragility fix (`task/w22-ssss-fragility` @ f80eb8e →
`task/w23-lockedout-ux`). Target: the real-world state Sean hit — an account
that already has Secure Secret Storage (usually created in Element) while a
fresh Linnet device sits locked.

## Shipped

### A — "Try my account login password" (unlock screen)
Many Element users accepted the old default of *security passphrase == account
login password*. The unlock screen now offers a third affordance that reveals
a `current-password` field and runs the SAME core unlock path
(`unlockWithSecret({ passphrase })`). The password is never stored or
prefilled — failed attempts wipe it from the field.

### B — "Reset security access" (DESTRUCTIVE)
For users who forgot the passphrase AND lost the recovery key. This is NOT a
recovery — nothing protected by the old 4S key comes back. The flow:

1. honest impact screen (old backup history gone; new messages backed up with
   the new key; other sessions show one-time "identity changed"; account
   password required) behind an "I understand" checkbox;
2. account password + new passphrase (min 8) + confirm;
3. core `resetSecurityAccess` (packages/core/src/e2ee.ts), order matters and
   is unit-proven: **rotate 4S first** (`createRecoveryKeyFromPassphrase` +
   `bootstrapSecretStorage({ setupNewSecretStorage, createSecretStorageKey })`),
   **then NEW cross-signing** (`bootstrapCrossSigning({ setupNewCrossSigning:
   true, authUploadDeviceSigningKeys })` — the UIA step; payload carries
   `identifier { type: "m.id.user", user }` per the W5a trap), **then backup**
   (`resetKeyBackup()` — which on 45.1 deletes all old versions first, then
   `checkKeyBackupAndEnable()`);
4. forced one-time recovery-key acknowledgment (W21 pattern).

Wrong-password / UIA 403 messages propagate VERBATIM (b28e991 rule) — only
the decryption-error family is reworded via `mapSecretStorageError`.

### D — "What your account actually has" (diagnostics)
Core `describeSecurityAccount(client)` performs W22-style SERVER-first reads
of `m.secret_storage.default_key`, every enumerable `m.secret_storage.key.*`
description (default + guarding-id union + local sync-cache enumeration), the
four secrets' `encrypted` key-id maps, and the backup version
(`http.authedRequest(Method.Get, "/room_keys/version")`). Returns a plain
object with an actionable headline mapped by rules:

- no secrets stored at all → no cross-signing secret, reset/other session are
  the paths;
- no passphrase-derived key → recovery-key-only account, use the key or reset;
- default key is passphrase-derived → names the key and points at Element's
  Settings → Security & Privacy;
- stale non-default guarding ids (the W22 shape) → note about Element key
  rotations; current key should still work.

Key ids are public account data — shown in full; ciphertext/iv/mac are never
read into the description. `describeSecurityAccountText` serializes it for the
"Copy details" support clipboard action. The gate shows the readout behind an
always-available "Show details" link and auto-reveals it after two failed
unlock attempts; the security center carries the same disclosure plus the
reset entry.

## Parked

### C — cross-session approve-unlock (m.secret.request share) — BLOCKED UPSTREAM
Receiving the SSSS key from another verified session via the to-device
`m.secret.request`/`m.secret.send` flow is impossible on the current stack:

- `@matrix-org/matrix-sdk-crypto-wasm@18.9.2` exports ZERO secret-share
  primitives (grep-verified against the installed package), and
- matrix-js-sdk 45.1.0's rust-crypto backend has no `m.secret.request`/
  `m.secret.send` handling to unwrap a shared secret — the device private
  curve25519 key needed to decrypt the forwarded `m.secret.send` is
  unreachable from JS.

Re-test on future wasm / js-sdk bumps (grep
`matrix-sdk-crypto-wasm` for secret-share exports; check js-sdk changelog for
rust-crypto secret-request handling). Until then, routes A + B + D are the
complete story for locked-out users.

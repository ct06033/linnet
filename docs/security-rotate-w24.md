---
tags: [linnet, docs, security, w24]
status: done
updated: 2026-11-24
---
# W24 — route E: rotate the recovery method (non-destructive)

Sean's flow, verbatim intent: ask for the **recovery key** (the one Element
and other clients show; the passphrase is the same door via a toggle) →
**set a NEW passphrase** → result: Linnet **decrypts history now** and the
new passphrase is the credential for **future logins on every device**.
Non-destructive: same cross-signing identity, same backed-up history; the
old credential stops working for 4S fetches afterwards. NO UIA, NO account
password. This is the middle path between "unlock" (W14 — same credential)
and the destructive Reset (W23-B — new identity, history of the old era
gone). See `security-lockedout-w23.md` for the sibling routes.

## Core — `rotateRecoveryMethod` (`packages/core/src/e2ee.ts`)

Order matters:

1. **PROVE (reads only).** Derive candidate key bytes from the typed secret
   (`deriveCandidateKey` — shared with `unlockWithSecret`, whitespace
   normalization + actionable base58 copy included), then try EVERY secret
   (`m.cross_signing.master/self_signing/user_signing`, `m.megolm_backup.v1`)
   with `decryptSecretWithKey` (W22 multi-copy). Anything decryptable =
   proof; nothing = `wrong passphrase or recovery key` with **zero writes**
   (the standing no-mutation rule).
2. **EDGE H check**: master (decryptably) present in 4S?
3. **NEW passphrase → new SSSS key**: `createRecoveryKeyFromPassphrase`
   (SDK builds the m.pbkdf2 keyInfo), min 8 enforced; BOTH client-level
   holders (bootstrap + unlocked) re-seeded to the new key so no stale
   callback answer can encrypt new-id entries with old bytes.
4. **ROTATE 4S**: `bootstrapSecretStorage({setupNewSecretStorage:true,
   createSecretStorageKey})` — deliberately NO `setupNewKeyBackup`: the
   server backup version and its keys are the user's history.
   **RE-WRAP**: every secret decrypted in step 1 is stored again via
   `client.secretStorage.store(name, value)` under the new default key.
5. **UNLOCK THIS DEVICE** (the W14 pattern): force
   `getUserDeviceInfo([me], true)` FIRST (silent-import trap), then
   `bootstrapCrossSigning({})` — the **IMPORT branch**;
   `setupNewCrossSigning` NEVER appears in this flow. Feed the backup key to
   the machine (`storeSessionBackupPrivateKey`), `checkKeyBackupAndEnable`,
   `restoreKeyBackup`. Returns `{recoveryKey, imported,
   crossSigningImported, masterSecretWasStored}`; `onKey` fires as soon as
   the rotation commits.

## The 45.1 ground truth (skill ledger)

* `rust-crypto.js bootstrapSecretStorage` with `setupNewSecretStorage:true`
  only **adds the new key** (`addKey` + `setDefaultKeyId` +
  `cacheSecretStorageKey`). It auto-re-stores the cross-signing secrets
  **only if THIS machine caches their private keys**
  (`olmMachine.exportCrossSigningKeys()`) and the backup key only via
  `saveBackupKeyToStorage()` when the machine caches a decryption key that
  MATCHES the current version. A locked device (fresh login, nothing
  imported) does neither → **Linnet must re-wrap the secrets itself** (on an
  already-unlocked device the SDK's auto-stores run too and our stores are
  idempotent overwrites).
* `ServerSideSecretStorageImpl.store()` **replaces the whole `encrypted`
  map** with the new-key entry — re-wrapping therefore RETIRES the old
  credential for 4S fetches automatically (live-proved: K1 decrypts nothing
  post-rotation).
* `CrossSigningIdentity.bootstrapCrossSigning` without
  `setupNewCrossSigning` takes the import-from-4S branch (single-shot
  callback get + `importCrossSigningKeys`) — the identity-stays-identical
  requirement. When the master secret is absent (edge H) it silently does
  nothing; we skip the whole leg ourselves and report it.

## Edge H — cross-signing exists, master NOT in 4S

Old Element accounts verified before SSSS never stored the master secret.
Rotation still proceeds (wrap whatever exists — usually only the backup
key), history decrypts, but this device gets no cross-signing import and
stays unverified. Non-fatal; the key view says: "Your identity keys were
never stored in your recovery setup — the new passphrase works for history
now; to verify this device, use Element's cross-verification, or full Reset
in Linnet."

LIVE subtlety found on HS-A: if the ROTATING device is the original
bootstrap device (machine still caches the cross-signing PRIVATE keys),
45.1's `bootstrapSecretStorage` AUTO-RE-STORES the master secret from that
cache — edge H self-heals on that device (the rotate result flag still
honestly reports `masterSecretWasStored:false` because the PROOF step never
saw it, and the import leg is correctly skipped: the keys were already
local). The stuck edge H only persists when rotation runs on a device with
nothing cached — which is exactly the gate scenario, live-proven in
`e2ee-rotate-live.test.ts` (master stays absent for all devices; the
rotating device reports `isCrossSigningReady=false`).

## UI

* `RotateSecurityPanel` (`packages/app/src/modules/security/gate.tsx`) —
  2 steps + progress + forced-ack: (1) "Confirm your current recovery key"
  (unmasked text input, W21 normalization/hint rules, "use my passphrase
  instead" toggle); (2) "Choose your new security passphrase" (min 8 +
  confirm) → "Rotating keys and decrypting your history…" → ONE-TIME view
  of the NEW key ("the old recovery key and passphrase no longer work… this
  is the only time the new key is shown").
* Entries: unlock screen link ("Lost your passphrase? Rotate your recovery
  method", `rotate-entry`) and the Security center
  ("Recovery settings → Rotate", `start-rotate`).
* Copy rules: never promise old-key access post-rotation; state plainly:
  history kept, identity kept, old credential retired. Decryption-family
  errors reworded via `mapSecretStorageError`; everything else verbatim
  (b28e991). No sensitive input survives a failed attempt (W23-A rule).

## Tests

* Unit core (`e2ee-rotate.test.ts`): real AES payloads, sdk.ts-mirroring
  callback. Proof-before-write ORDER; failed-proof snapshot equality; all
  four secrets re-wrapped under the new default ONLY; returned key decodes
  to the new bytes; both proof flavors; stale-copy account; edge H path
  (no cross-signing call at all); import-failure honesty (partial result,
  no raw leak) vs UIA-shaped verbatim propagation.
* Unit app (`gate-w24.test.tsx`): gating, toggle, forced-ack once, error
  mapping, edge-H copy, center entry.
* LIVE HS-A (`e2ee-rotate-live.test.ts`, env `LINNET_TEST_HS`): the
  acceptance bar — **master PUBLIC key IDENTICAL before/after** — plus
  default id changed, every secret decrypts with the P2-derived key, K1
  rejects (actionable, never raw), backup VERSION unchanged, history
  restored now (imported>0), device2 unlocks with P2, device3 with K2,
  wrong proof mutates nothing on the server, and edge H live.
  Run: `LINNET_TEST_HS=http://192.168.50.70:8023 pnpm --filter core exec vitest run src/e2ee-rotate-live.test.ts`

## Limitations (honest)

* Rotation of the recovery method requires the old credential — this is not
  a way into a fully forgotten setup (that is W23-B Reset, destructive).
* Device verification state of OTHER sessions is untouched; other devices
  simply need the NEW passphrase/K2 on next unlock (the old one stops
  working for them too — that is the point of rotation).
* The SDK's single-shot internal import limitation (W22) carries over: if
  the import inside step 5 fails with a bad-MAC-shaped error, rotation
  still completes and reports `crossSigningImported=false`.
* 45.1 `isCrossSigningReady` can report TRUE for a fresh device from
  public-identity trust alone (rust `getCrossSigningStatus`), so the
  edge-H "device stays unverified" UI copy is driven by the rotate
  RESULT flag `masterSecretWasStored` (unit + live proven: the master
  secret genuinely isn't in 4S), never by that predicate.

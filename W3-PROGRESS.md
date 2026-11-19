# W3B-PROGRESS (core security lifecycle — COMPLETE)
- [x] e2ee.ts: bootstrapSecurity (cross-signing + 4S w/ passphrase SSSS + backup create + machine enable)
- [x] restoreBackupWithPassphrase: 4S route (PBKDF2 desc -> sss.get(megolm_backup.v1) -> storeSessionBackupPrivateKey -> restore)
- [x] restoreBackupWithRecoveryKey: SAME 4S route (recovery key IS the SSSS key, NOT the backup key — bug caught by HS test)
- [x] e2ee-setup.test.ts integration (HS-A): bootstrap -> upload proof -> passphrase restore (dev B) -> recovery-key restore (dev C) -> wrong-passphrase rejection (dev D). 10.5s green.
- [x] HS-A rate limits fixed at root: Synapse >=1.147 uses dotted rc_login.address/.account keys; nested block ignored (0.003/s defaults were causing 429 flakes).
- gotchas logged to skill matrix-js-sdk-testing: upload-loop re-triggers only on key RECEIPT or version switch (sender sessions wait); resetKeyBackup marks everything re-uploadable; Synapse GET /room_keys/keys?version caches empty (use /room_keys/version count); UTD placeholder body ("** Unable...") counts as set - filter it; initial_device_id for second-device logins; bootstrapSecretStorage needs getSecretStorageKey via cryptoCallbacks (holder seam).
- REMAINING (3b-2): SAS/QR verification UI flow (requestDeviceVerification orchestration + emoji compare), device-settings screen, security banner. Group-call + threads/polls waves follow.

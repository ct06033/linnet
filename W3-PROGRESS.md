# Wave 3a — E2EE relay homeserver + crypto round-trip

Deliverable checklist:

- [ ] 1. `packages/core/src/relay-homeserver.ts` — createRelayHomeserver(config): shared in-memory homeserver with E2EE handshake endpoints:
  - [ ] accounts + login (identifier shape) / logout / whoami
  - [ ] rooms with full state snapshots (create, room_version, power_levels, encryption, per-member joins) via ev() honoring FIXTURE REQUIREMENTS
  - [ ] GET /filter, GET /sync (initial snapshot once, then incremental queues; no 429 on old since)
  - [ ] PUT /rooms/{id}/send/{type}/{txn} → append timeline (preserve ciphertext as-is)
  - [ ] PUT /sendToDevice/{type}/{txn} → fanout to_device queues
  - [ ] POST /keys/upload, /keys/query, /keys/claim (OTK popped, never re-issued), GET /keys/changes
  - [ ] unhandled path → {} 200
- [ ] 2. SessionManager: `opts.initCrypto?: boolean` — await client.initRustCrypto() after login + inside restore() before first startClient; default false; existing tests unchanged-green
- [ ] 3. `packages/core/src/e2ee.test.ts` — real Megolm round-trip:
  - [ ] two SessionManagers (alice, bob) on ONE relay
  - [ ] alice sends m.room.message → wire content is m.room.encrypted on relay raw store
  - [ ] bob decrypts to exact body "hello bob"
  - [ ] assert OTK claim happened (no handshake bypass)
  - [ ] 30s timeout per test
- [ ] 4. Gate: `pnpm -r build` / `pnpm -r typecheck` / `pnpm -r test` all green (prior 21 tests stay green); commit explicit paths; push task/e2ee

Status log:
- (init) brief received, install done.

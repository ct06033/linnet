# W3-PROGRESS (wave 3a complete)
- [x] relay-homeserver.ts (multi-user shared state: sync queues, send, sendToDevice fanout, keys upload/query/claim) — kept for FUNCTIONAL tests only
- [x] SessionManager.initCrypto (initRustCrypto before startClient; login swaps in credentialed client)
- [x] e2ee.test.ts = LIVE-HS integration (LINNET_TEST_HS env): real Megolm round-trip alice→bob in 1.8s on Synapse HS-A
- [x] gates: build/typecheck/test green (relay e2ee test replaced; unit suite intact)
- learned (hard): wasm rust-crypto does not tolerate the in-process fake for the key-sharing
  lifecycle ("null pointer passed to rust" on sync changes; outgoing request queue stalls).
  Decision: crypto scenarios ALWAYS run against HS-A fixture. HS-A: docker linnet-hs-a on
  Melchior :8023 (registration open, sqlite). Login rate limit: legacy rc_login block ignored
  (v2 schema) — tests use the register-returned session directly.
- login type bug: "m.password" is wrong everywhere; spec is "m.login.password" (relay never
  checked; Synapse did). session.ts fixed.

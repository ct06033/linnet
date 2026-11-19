# PROGRESS — W4c media/voice (COMPLETE)

Shipped: encrypted attachments (A2HS), authenticated media downloads, image
lightbox viewer, voice messages (record → Opus/webm + peaks → waveform UI).

## What landed
- `modules/media/crypt.ts` — spec-exact A2HS: AES-256-CTR (raw IV as counter,
  length 64 — matrix-js-sdk parity), SHA-256 over CIPHERTEXT verified BEFORE
  decrypt, JWK base64url handling. No invented fields.
- `modules/media/core.ts` — uploadBytes (fetch + bearer), prepareMediaContent
  (plain vs A2HS branch), resolveMediaSrc (cached blob resolution), peaks
  JSON round-trip (Element-compatible info.json.url), VoiceRecorder
  (getUserMedia + MediaRecorder webm;opus, AudioContext RMS peaks @100ms,
  injectable deps), blobToBytes jsdom fallback.
- `modules/media/renderers.tsx` — ImageBody (auth-or-encrypted fetch → blob),
  VoiceBody (waveform bars, play/pause, seek click, MSC1767 duration),
  FileBody (Save → blob download), Viewer lightbox (Esc/arrows/close/next).
- fake-HS: media upload now STORES bytes; `/media/download` + `/thumbnail`
  routes serve them (M_NOT_FOUND unknown); POST+PUT accepted.
- Composer: attach() branches on room encryption; 🎤 record bar with live
  peaks, timer, send/cancel. Voice send: m.audio + org.matrix.msc3245.voice
  + msc1767 duration/waveform + json peaks; encrypted rooms get file-object.
- RoomView: viewer state, onOpenImage seam through TimelineItemProps.

## Root causes archived (for future waves)
1. JWK `k` from exportKey is **base64url** (`-_`); atob demands base64 —
   must translate or decrypt throws InvalidCharacterError (also bites
   browsers, not just jsdom).
2. Spec hashes SHA-256 of the CIPHERTEXT (verify before decrypt); hashing
   plaintext silently breaks Element interop.
3. jsdom Blob has no `.arrayBuffer()` — FileReader fallback needed.
4. jsdom `crypto.subtle` missing — swap `node:crypto` webcrypto into global.
5. Media helpers use global fetch while js-sdk uses its injected fetchFn —
   any test that renders media must `vi.stubGlobal("fetch", fake)`.
6. `navigator.mediaDevices.getUserMedia` is a *required* method in lib.dom
   types → truthiness check trips tsc 2774; cast to optional first.

## Gates
- app 79/79 (10 files; +9 W4c), core 17/17 + session 5/5,
  HS-A live Megolm round-trip re-proven 1.7s,
  pnpm -r build clean.

Next: W5a E2EE UI (security banner, verification, key backup flows, recovery).

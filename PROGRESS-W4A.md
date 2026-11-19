# W4a — ROOMVIEW (room-open + timeline + composer core)

Scope source: docs/prd.md §6.2 (messaging core, MVP rows) + §6.9 registry-as-seam,
trimmed to the "core" slice delegated to this wave: **room open + continuous
timeline + composer**. Threads/polls/verification UI follow in later waves
(per App.tsx wave-3 marker "timeline arrives wave 4 (threads + polls next)").

## Deliverables checklist

- [x] Room open: click room row → RoomView (header: name, topic, E2EE badge, joined-member
      count); invite rooms show a Join banner; room resets on account switch/sign-out.
- [x] Timeline: live-timeline + local-echo (pending) events, sender-grouped stream
      (same sender, ≤5 min), timestamps, membership system lines (join/leave).
- [x] Renderers via registry `timeline-item` slot (first-party module `linnet.messages` —
      API honesty per §6.9): m.text, m.notice, m.emote, m.image, m.file/audio/video,
      redacted, unable-to-decrypt, member lines.
- [x] HTML formatted-message sanitising render (spec allow-list, own DOMParser
      sanitiser — no new npm deps) + markdown fallback (+ spoilers `||x||`).
- [x] Emoji shortcodes (:tada: → 🎉) in the composer→message pipeline.
- [x] Reply affordance: `m.in_reply_to` pill above the message (fallback-quote
      stripped); reply mode in composer; "(edited)" badge + latest-content
      aggregation for `m.replace` edits; aggregated reaction pills (count, "mine"
      highlight) + quick emoji add/remove (own → redact).
- [x] Read receipt: `sendReadReceipt` on open + on new bottom event; typing
      indicators: incoming `m.typing` → "X is typing…", outgoing `sendTyping` throttled.
- [x] Pagination: "Load earlier" / near-top scroll → `client.paginateEventTimeline`.
- [x] Composer: multi-line + auto-grow, Enter/Shift+Enter, per-room draft, rich-text
      toggle (formatted_body on/off), send/edit/reply modes, **undo send**
      (redact own last message), `m.mentions` population incl. **@room guard**,
      slash commands via registry (`/me /join /part /invite /nick /topic /shrug`),
      `composer-command` slot wired (code-block insert demo), attachments:
      file button + drag-drop → `uploadContent` → m.image/m.file with status.
- [x] UTD affordance: `m.room.encrypted` that has no decryption success renders an
      honest "unable to decrypt" placeholder (UX polish in a later wave).
- [x] Fake homeserver (test fixture only) extended: timeline seeds, room topic,
      ephemeral typing, /send, /redact, /typing, /receipts, /join, /invite,
      /state, /displayname, /upload, /messages, + recorded call log for assertions.
- [x] Tests: sanitizer, markdown, grouping/aggregation pure fns, RoomView integration
      (open, group, send-echo, undo, edit, react, reply, /me, UTD, typing, receipts,
      pagination, attach) — all against the fake HS, no live homeserver.

## Deferred to later waves (honest scope notes)

- Threads (count badge + thread panel) and polls (MSC3381) — W4b.
- Full emoji picker (this wave: quick-react set of 8), mention autocomplete UI
  (this wave: `m.mentions` is populated from detected mx IDs).
- matrix.to in-app navigation, image-viewer chrome (zoom/download), "seen by"
  receipts list, jump-to-date/search, notifications/tray, spaces filtering.

## Deviations / environment notes

- app gains a `matrix-js-sdk` dependency **pin-parity with core (45.1.0)** for the
  renderer's event/room typings — not a new package to the ecosystem, and it is
  the same pinned instance pnpm dedupes; no other new npm deps.
- Gates in this worktree require `pnpm -r build` BEFORE the three gate commands
  (private packages expose types via `dist/`; CI does the same). Fresh
  worktree without a prior build shows false-red typecheck/test.
- (add further deviations below as they happen)

## Wave result (11-19)
- Gates green: core 17 unit (+2 HS-A integration re-proven 13.3s on detached-ordering branch),
  app 54 unit/integration (16-scenario RoomView suite over the upgraded fake HS), typecheck + vite build.
- Root causes logged: (1) startClient pendingEventOrdering=Detached required for getPendingEvents;
  (2) EventTimeline.getEvents() returns the INTERNAL MUTABLE ARRAY — copy it or React useMemo deps
  silently starve (stale edit aggregation); (3) annotation key lives in rel.key per spec;
  (4) m.typing ephemera content = user_ids; (5) js-sdk uploadContent prefers XHR over fetch when
  XMLHttpRequest exists (tests hide it); (6) Synapse 429 login buckets are in-memory — docker restart clears.
- Deferred honestly to next waves: full emoji picker + mention autocomplete UI (W4b), threads/polls (W4b),
  image-viewer chrome + voice waveform (W4c), UTD help UX polish (W5a), "seen by" expanded list (W4b).

# Push gateway design round (W19, 2026-11-21)

Status: DESIGN — awaiting Sean's decisions (§5) before spec + build.
PRD anchor: Decision #7 (locked): "local-only notifications at MVP; own push
gateway + UnifiedPush at P1". §6.6 lines: Sygnal-compatible gateway + hosted
default (P1), UnifiedPush/ntfy (P1), rules-UI (P2), email (P2).

## 1. Verified ground truth (this round, not memory)

1. Synapse mainline has **no native Web Push/VAPID** (repo search: only an
   unrelated openid.md mention). MSC4174 is implemented by Continuwuity
   (a Synapse fork), not Synapse. → an HS will not web-push by itself.
2. Upstream Sygnal (matrix-org + element-hq) has **zero webpush/web_push
   code** — it speaks APNs/FCM/"universal push" only. → running stock Sygnal
   delivers *nothing* for web or desktop; "own push gateway (Sygnal-
   compatible)" must mean **our own gateway implementing the spec'd
   HS→gateway interface** (`POST /_matrix/push/v1/notify`), not the Sygnal
   binary. That is spec-compatible by definition and a PRD-honest reading.
3. Desktop (Win/Linux Electron) has **no vendor push channel when the app is
   closed** — FCM/APNs don't exist for these builds. Matrix clients solve
   "closed" on desktop with exactly two mechanisms:
   - **tray-resident process** (window closed, app alive → in-app notify path
     we already have works; this is what Element Desktop users do), and
   - **email pusher** (Synapse sends mail via its own SMTP — zero gateway
     infra, server-dependent, works with any client's HS incl. matrix.org).
4. The web build ships **no service worker and no manifest** — web push
   needs the whole PWA substrate (manifest, SW, subscription flow) built
   first. Also: is the web bundle even deployed? PRD #8 says Balthazar;
   vault shows the container/backlog but no deploy log. (Decision D0.)
5. Linnet today: NotificationEngine = in-app (running window) rules + OS
   notifications; **no pusher registration code anywhere**; `window.linnet`
   bridge has setBadge/notifications; tray absent (main.ts header still says
   "Notifications/tray land W6").
6. UnifiedPush's value targets **Android** (distributors exist there;
   desktop Linux has niche ones, Windows none). Meaningless before a mobile
   app — the PRD line is future-proofing, not now.

## 2. Consequence

"Push for Linnet" is one protocol (HS→gateway `notify`) + three very
different *delivery* problems:

| platform | closed-app push today? | path |
|---|---|---|
| Desktop Win/Linux | ✗ (no vendor channel) | tray-resident + email pusher |
| Web (Chrome/FF/Edge desktop+Android) | possible | PWA substrate + own webpush gateway |
| iOS web | installed-PWA only (16.4+) | same gateway, test later |
| Mobile apps (none yet) | n/a | same gateway + Sygnal-or-FCM/APNs module *when an app exists* |

## 3. Proposed phasing

**3a — zero-infra wins (desktop-first):**
- Tray: minimize-to-tray default, "start minimized at login", in-app
  notification rules already exist — this makes "closed window" notify TODAY
  (Electron `Tray`, ~small surface; finish the W6 stub note).
- Email pusher UI (settings toggle): register/delete a Synapse email pusher
  + a mentions/DMs-only push rule; capability-probe the HS; graceful
  "your homeserver doesn't do email" state. Exact pusher payload shape to be
  pinned against spec + HS-A during implementation (verified empirically,
  not assumed).
- Both land for web too (web can at least toggle email).

**3b — web push vertical slice (needs D0 = web deployed):**
- PWA substrate: manifest + service worker (own SW, no vite-pwa dep unless
  it earns its keep) + subscription lifecycle (permission, expiry, resync).
- **linnet-push**: small stateless Node gateway implementing
  `/_matrix/push/v1/notify` → web-push (VAPID keys ours), shared-secret per
  registration + rate limit + no content logging; pusher `data` carries the
  subscription JSON (stateless — no DB). Deploy: Balthazar container + swag
  vhost (mirror the call.nervweb.com pattern; name e.g. `push.linnet.…`).
- E2EE policy v1: unencrypted rooms push body text; encrypted rooms push a
  generic "new message" badge (no content theft, no SW-time decryption).
- `config.json` `pushGatewayUrl`: web build registers only when configured
  (BYO deploys get it by setting the URL; hosted default = ours).

**3c — mobile-ready (NOT now):** when/if a mobile client exists, extend
linnet-push with FCM/APNs modules (or swap in real Sygnal alongside — its
native turf) + UnifiedPush distributor guidance. PRD line satisfied then.

## 4. Risks / limits (honest)
- Email pusher = server-dependent (matrix.org yes; many self-hosts no email).
  We probe, never promise.
- Tray-resident ≠ machine asleep/off; that residual need is exactly what
  3b/3c solve for web/mobile, and email covers desktop-fallback.
- iOS Safari web push requires installed PWA + user opt-in; ship-and-see.
- VAPID key custody: generated once, stored off-NAS backup (Balthazar is the
  NAS — keys live outside its pools; Infra doc).
- PRD wording: "Sygnal-compatible" ≠ "runs Sygnal"; §1.2 justifies. Amend PRD
  text with this finding at spec time (grounded-citations rule).

## 5. Decisions requested (recommendation in bold)
- **D0** Deploy the web bundle on Balthazar as part of this wave, or is web
  parked? → **3b gates on this; if parked, ship 3a now, hold 3b.**
- **D1 Scope now:** **3a (tray + email) approved to build; 3b scheduled
  after D0**, 3c explicitly deferred.
- **D2 Tray defaults:** **close→tray ON, autostart OFF** (user opts in
  Settings), tray menu: open / pause-notify / quit.
- **D3 Email UX:** **mentions+DMs only, one toggle**, HS-probe with plain
  result text; no per-room email rules in v1 (rules-UI is P2 anyway).
- **D4 Gateway:** **build tiny stateless linnet-push (webpush-only)**; do
  NOT deploy stock Sygnal now (no webpush; postgres+redis ops for zero gain
  at this stage).
- **D5 E2EE push content:** **generic badge for encrypted rooms** in v1.
- **D6 Gateway URL/origin:** **`push.<same apex as call host>` on Balthazar
  swag**, VAPID subject = founder contact email Sean chooses.
- **D7 Verification bar (per your quality rule):** eval = live matrix.org +
  HS-A email-pusher round trip; E2E browser test of webpush on the deployed
  web build; gateway pen-checked with replay/wrong-secret/overlong payload
  tests; UI click-through with UX eyes (your standing rule).

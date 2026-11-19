# PRD (DRAFT v0.1) — "Linnet": a Matrix client between Element and Cinny
Date: 2026-11-18 · Status: **SCOPE LOCKED v0.2** (all open decisions answered by Sean 2026-11-18) · Repo: github.com/ct06033/linnet · License: AGPL-3.0-only
Research base: ~/.hermes/plans/research-matrix-clients/{element.md, cinny.md} (cited, Nov 2026)

## 1. Summary & positioning

A desktop-first Matrix client for **Windows and Linux** that sits in the gap between
the two reference clients:

- **Element** (New Vector): the de-facto spec yardstick — threads, polls, spaces, the most
  complete E2EE verification/recovery UX, Element Call, bridges, enterprise login. But:
  Electron resource hog, slow startup/hangs on large accounts (still v2 full-sync),
  cluttered half-finished-feature sprawl (26+ labs flags), pinned to matrix-js-sdk `develop`.
- **Cinny** (Ajay Bura, AGPL): the "lean" pole — Discord-like 3-pane, calm continuous
  timeline, virtualized, Vite SPA, no Electron. But: **no threads in stable** (issue #257,
  open since 2022), **no polls** (#563), **no multi-account** (#66), fragile key-backup/
  verification UX (#2203/#2766), weak push, no admin/bridge/widget surface. Actively
  maintained but mid-rewrite onto a house SDK (~25% migrated May 2026, PRs frozen).

**The delta is the product**: Cinny's speed, density and calm — plus the four loudest
community asks Cinny won't ship soon (threads, polls, multi-account, reliable notifications)
— plus enough of Element's completeness that a power user never has to switch back.
Design law: every Element "must-match" surface (§5 of element.md research) is on our
roadmap; every Cinny gap is closed in MVP.

Why now: Element concedes its own perf problems (steers users to Element X, which is
mobile-only); the desktop spec-complete client slot is genuinely open. Cinny's SDK rewrite
signals the JS-sdk ceiling — we design around it (see §7).

## 2. Target users

1. **Discord/Slack refugees & power chatters** — many rooms, long histories, want speed
   and a calm timeline (Cinny's audience, matrix.org itself labels Cinny "good for Discord
   refugees").
2. **Self-hosters / privacy-first professionals** — E2EE done right, config-driven
   deployments, no forced SaaS, telemetry-off-by-default.
3. **Teams on Matrix (incl. Element Server Suite shops)** — SSO, spaces, calls, later
   admin surface. Secondary segment for MVP.

Platform: **Windows 10/11 x64 + Linux (x64/arm64)** are first-class (installers, tray,
notifications, auto-update). A hosted **web/PWA build ships from day one as a by-product**
(same SPA) but the desktop shell is the product. No mobile natives (non-goal §9).

## 3. Product pillars

1. **Fast, measurably.** Perf budgets with CI gates against a seeded large account (§8),
   virtualized timeline, lazy room state, sync+crypto off the main thread. "Between" means
   we beat Element on the same hardware and say so with receipts.
2. **Calm density.** Three-pane shell (spaces rail / room list / timeline), DMs separated
   from rooms, sender-grouped continuous stream (Cinny aesthetic) but with Element-grade
   reply/thread/pinned affordances visible on the original message. Comfort/compact
   density toggle. Keyboard-first (Ctrl+K command palette, full shortcut map).
3. **Trust engineering.** Element-grade verification + recovery flows are a day-one
   requirement, test-matrixed across multi-device/recovery/rotation scenarios; honest
   "unable to decrypt" affordances; security posture with credited fast advisories.
4. **Completeness on a leash.** Roadmap covers Element's must-match list, gated per
   phase; no labs-flag sprawl — every shipped setting is default-coherent, everything
   unfinished is invisible (opposite of Element's feature culture).
5. **One clean room.** Clean-room implementation (zero Element/Cinny code copy), Apache-2.0
   dependencies only where they matter (matrix-js-sdk is Apache-2.0).

## 4. Architecture (recommended defaults; alternatives in Open Decisions)

- **Core**: TypeScript + **matrix-js-sdk pinned to a stable release** (not `develop` like
  Element — their structural regression source) + **Vodozemac WASM** crypto (already the
  default in js-sdk 45). Everything protocol behind a `SessionStore`/SDK seam so a later
  swap to matrix-rust-sdk bindings (the Cinny lesson) doesn't touch UI code.
- **Sync**: classic v2 `/sync` long-poll for MVP; **MSC4186 Simplified Sliding Sync as the
  documented upgrade path** (Synapse ≥1.114 serves it natively; no proxy — the MSC3575 proxy
  is dead). Seam designed so switching is config, not rewrite. This is the #1 Element perf
  complaint lever; we must not bake it in wrong.
- **Threading model**: SDK client + crypto + timeline pagination run in a **Web Worker**
  (or worker_threads in shell main); UI thread only renders. This is where Element's
  large-account hangs come from; ours must not.
- **UI**: React 19 + Vite, TanStack Query + **@tanstack/virtual** timeline (Cinny-proven),
  vanilla-extract or Tailwind+vars theming (light/dark/system + accent + custom themes later),
  Slate-class markdown composer, i18next from day one (en only at first).
- **Shell**: **Electron** for Win+Linux: OS keychain secure storage (Element-proven pattern:
  optional native modules gate features), auto-update (win NSIS, linux deb/rpm/AppImage),
  tray, native notifications, `--profile` multi-instance. Tauri 2 kept as an explicit
  alternative (Decision #3) — lighter, but WebView2/WebKitGTK crypto/storage/notification
  caveats, and Linux WebKitGTK is the risky leg.
- **Distribution**: GitHub releases; PGP-signed tarballs (Cinny pattern) + winget manifest
  + Flathub/AppImage (later); self-host = serve `dist/` + `config.json` (homeserver,
  presets, lockdown flags — Element-grade deploy flexibility is a must-match).
- **Calls**: **in MVP** (Decision #6, raised by Sean): 1:1 = js-sdk WebRTC (native Matrix
  call events) + screen share; group = **embed Element Call via matrix-widget-api /
  element-call-embedded** (Cinny's v4.11.1 pattern — 80% of Element's capability with 20% of
  the surface). MatrixRTC/persistent video rooms P2+, tracked to spec, not invented by us.
  Verify element-call embedded package license before wiring (risk §10.4).

## 5. License & legal

- No vendoring/copying of AGPL code (Element is multi-licensed AGPL/GPL/commercial; Cinny
  AGPL-3.0-only). Clean-room discipline enforced in review: reference their docs, never
  their source, until our license decision.
- **AGPL-3.0-only — LOCKED** (matches both peers, prevents closed copy-forks). Published
  publicly at **github.com/ct06033/linnet** (Sean: "make sure to publish to github").
- Element Call embed: its repo is open-source; verify current license before wiring (risk §10).

## 6. Full feature set (all phases) — MVP first

Legend: **M0** = pre-alpha plumbing, **MVP** = v0.1 usable-daily, **P1** = v0.2–0.5,
**P2** = v0.6–1.0 "full Element parity surface", **Later/Non-goal**.

### 6.1 Auth & accounts
| Feature | Phase |
|---|---|
| Password login; custom homeserver; `.well-known` discovery; account picker | MVP |
| Legacy SSO (UIAA redirect: SAML/CAS/OIDC-relay) | MVP |
| Multi-account (isolated stores, active-view switch) | **MVP** (Decision #5) |
| Device/session management + revoke own sessions | MVP |
| Native OIDC/MAS (Matrix 2.0) login | P1 |
| QR login from Element X (MSC4108) | P2 |
| PKCS#11/HSM secure storage | P2 |

### 6.2 Messaging core
| Feature | Phase |
|---|---|
| Send/edit/delete(=redact)/undo-send; threaded replies **with count badge on parent + thread panel** | MVP |
| Reactions (emoji picker, aggregated), mentions incl. @room guard, read receipts, typing | MVP |
| Markdown composer + rich toggle, code highlight, spoilers, emoji shortcodes, slash commands | MVP |
| **Polls (MSC3381: create/vote/results)** | MVP |
| Attachments: drag-drop, image viewer, encrypted files; **voice messages** (Opus + waveform) | MVP |
| HTML formatted-message sanitising render; matrix.to links | MVP |
| Reply threading affordances; forwarded/matrix URI handling | MVP |
| Message pinning + pinned list | P1 |
| URL previews (client-fetched OG), inline PDF viewer, syntax copy/download chrome | P1 |
| Jump-to-date (MSC3030), message search over local index | P1 |
| Live location sharing (MSC3488) | P2 |
| LaTeX/KaTeX | P2 |

### 6.3 Organization
| Feature | Phase |
|---|---|
| 3-pane shell; DMs vs rooms sections; unread/badge/notification filters; low-priority | MVP |
| Spaces: view/join/nest/read; basic space create + add rooms | MVP |
| Favourites section; breadcrumbs of recent rooms | P1 |
| Room list sorting modes; custom lists via spaces; explore/join public rooms, knock/request-to-join (MSC4140?) | P1 |
| Space admin (permissions, visibility, addresses), bookmarks saved-items | P1 |
| Full room-upgrade (version tombstone + one-click upgrade) | MVP basic / P1 full |

### 6.4 Security / E2EE (the make-or-break surface)
| Feature | Phase |
|---|---|
| Encrypt DMs + private rooms by default (Megolm/Vodozemac) | MVP |
| SAS emoji **and QR** verification; session/device verify flows | MVP |
| Cross-signing bootstrap; device settings sheet | MVP |
| Server key backup + **recovery key & passphrase (SSSS)** restore flows — polished, tested | MVP |
| Key import/export; "unable to decrypt" help UX | MVP |
| Per-device exclusion policies ("exclude insecure devices") | P1 |
| Dehydrated devices; encrypted state events (MSC4362); edit-compat policy | P1–P2 |
| Security notification centre (new-device alerts) | P2 |

### 6.5 Calls & presence
| Feature | Phase |
|---|---|
| Presence + status display | P1 |
| 1:1 WebRTC voice/video + screen share (native call events) | **MVP** (Decision #6) |
| Group calls via embedded Element Call | **MVP** (raised from P1 by Sean 11-18) |
| MatrixRTC (MSC4143/LiveKit), persistent video rooms, call slots | P2 |

### 6.6 Notifications
| Feature | Phase |
|---|---|
| OS-native notifications + tray badge + sounds (own soundset); per-room mute; mentions/keywords rules | MVP |
| Push while app closed: own push gateway (Sygnal-compatible) + hosted default | P1 (Decision #7) |
| UnifiedPush/ntfy option | P1 |
| Notification-rules settings UI (Element's push-rule beta parity) | P2 |
| Email notifications (server-dependent) | P2 |

### 6.7 Collaboration / ecosystem
| Feature | Phase |
|---|---|
| Widgets host (matrix-widget-api, iframe) | P1 |
| Bridge info tab (MSC2346) — compatible with hosted/paid bridges, no bridge mgmt UI | P1 |
| Moderation: report content, ignore user | P1 |
| Mjolnir ban-lists (MSC2313), room admin/audit surfaces | P2 |
| config.json lockdown/branding for enterprise deployments | P1 |

### 6.8 System/platform
| Feature | Phase |
|---|---|
| Win NSIS installer + Linux deb/rpm/AppImage; portable profile dirs | MVP |
| Auto-update (signed) | P1 |
| Theming: light/dark/system + accent | MVP; custom themes import/export | P2 |
| Keyboard shortcut map; multi-window/tab capture | P1 |
| Accessibility: focus management, screen-reader labels, what-input pattern | MVP (continuous) |
| i18n pipeline | P1 (en at MVP) |
| Encrypted-room full-text search (local native index, seshat-style) | P1–P2 |

### 6.9 Extensibility (Decision #10 — Sean: "should be plugin/extensible, add features quickly")
| Feature | Phase |
|---|---|
| **Module registry from day one**: every feature (timeline, composer, panels, call UI) is a registered module contributing to typed slots/hooks — first-party code uses only the public seam, so the API stays honest | MVP |
| Feature-flag + lazy per-module chunks (added features never grow boot path) | MVP |
| `linnet.config` file: user-level module enable/disable + per-module options | MVP |
| Out-of-process/third-party plugin surface (sandboxed iframe-widget-style or URL-imported ES modules — pick after spike) + minimal manifest | P1–P2 |
| Sample plugin shipped as API proof (e.g. a KaTeX or lottery widget) | P2 |
| Dev docs: `docs/plugins.md` with working example in-repo from wave 1 | P1 |

## 7. Performance budget & quality gates (measured, not vibes)

All numbers are **hypotheses until the live baseline wave** (app-build rule: spec numbers
are hypotheses); CI perf harness runs against a seeded account on a fixed runner:
- Login→interactive: ≤ 800 ms fresh; **≤ 1.5 s on 500-room account** (Element baseline
  measured on same fixture, target ≥2× faster).
- Steady-state RAM: **≤ 350 MB** with 500 rooms / 10k-event timeline (Element ~2–4× this
  per complaint corpus; we cite our own measurements at release).
- Timeline scroll 60 fps at 10k events virtualized; incremental sync idle CPU ≤ 5%.
- Initial JS ≤ 1 MB gz; everything else lazy chunks.
- E2EE scenario matrix green (2 accounts × 3 devices, recovery, key-rotation, upgrade)
  before any "E2EE ready" claim.
- Zero-copy CI guard: fuzz importer that blocks committed blobs matching Element/Cinny
  source fingerprints.

## 8. Analytics & privacy

Crash reports via self-hostable Sentry, **opt-in at first run**; zero product analytics,
ever (deliberate contrast with Element's PostHog). No phone-home beyond configured homeserver
+ optional push gateway. Honest defaults marketing.

## 9. Non-goals

- No iOS/Android native apps (responsive web is the fallback).
- No forks of Element/Cinny; no code reuse from AGPL sources.
- No homeserver admin tooling beyond client-side power-levels; no Synapse-Admin clone.
- No bridge *management* UI (running appservices is a server-side op we merely render).
- No plugin *marketplace/runtime sandbox* ambitions at MVP — extensibility = internal module
  registry + config toggles first (Decision #10); third-party plugin API lands P1–P2 once the
  internal seam has proven itself under first-party features.
- No inventing proprietary call/media protocols — we track Matrix spec/MSCs.

## 10. Risks

1. **matrix-js-sdk ceiling** (Cinny is rewriting precisely because of it) — mitigated by the
   SDK seam + worker-thread design + sliding-sync path; budget a real re-eval at v0.3.
2. **E2EE recovery UX is where lean clients die** (Cinny #2203/#2766). Mitigation: disproportionate
   MVP test budget here; it is our credibility surface.
3. **Push gateway cost/ops** — desktop-only notifications are fine closed; app-closed push
   needs infra (Decision #7).
4. **Element Call embed license/trademark** — verify repo license + naming rules before P1.
5. **Perf claims backfire if unevidenced** — publish methodology + repro script with every
   benchmark claim, founder-voice honest.
6. **Spec moving target** — pin "Matrix 1.x stable modules at each release" policy.

## 11. Decision log — LOCKED (Sean's answers, 2026-11-18)

1. **Name**: **Linnet** — approved.
2. **License**: AGPL-3.0-only; **publish on GitHub** (ct06033/linnet, public).
3. **Shell**: Electron.
4. **SDK**: matrix-js-sdk pinned to stable.
5. **Multi-account**: in MVP, architecture-level from day one.
6. **Calls**: **group calls promoted into MVP** (1:1 native WebRTC + embedded Element Call
   for group) — Sean's raise, recorded.
7. **Push**: local-only notifications at MVP; own push gateway + UnifiedPush at P1.
8. **Web/PWA**: yes — **hosted on Balthazar** (NAS, 192.168.50.121; serve `dist/` +
   `config.json` via a container/reverse-proxy on the existing Unraid box).
9. **Non-goals §9**: approved (with #10 refinement below).
10. **(new) Extensibility**: plugin/extensible — "I want to be able to add features
    quickly" → module-registry seam from day one (§6.9); internal-first, third-party
    surface only after the seam proves itself.

## 12. Kickoff (in flight now)

Repo github.com/ct06033/linnet created (AGPL LICENSE + README + docs/prd.md on main);
hermes kanban board `linnet` with wave-1..6 build tasks + USER-REVIEW gate task;
wave-1 (scaffold: Electron+Vite+React workspace shell, module registry seam, installer
configs, CI perf-harness stub) dispatched to BUILDER in its own worktree/branch per
parallel-work protocol. One builder per worktree; orchestrator merges serially; dev
deploys unprompted; prod/release gate = Sean's explicit ask.

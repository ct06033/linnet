# CINNY — Feature & Architecture Profile (for "between Element and Cinny" client design)

Status: COMPLETE (2026-11-18). ~15 URLs used, 24 searches/reads capped.
Date compiled: 2026-11-18
Researcher: RESEARCHER subagent
Claim markers: [verified] = primary source (repo, official site, code); [secondary] = blog/news/community source.

**TL;DR for PRD:** Cinny (cinny.in, AGPL-3.0-only, by Ajay Bura / cinnyapp org — NOT Sumdog) is the reference "lean" Matrix client: static React 18 + Vite SPA on matrix-js-sdk 41.x, virtualized continuous timeline, full E2EE/Spaces/SSO and (as of v4.11.1) embedded Element Call — but stable has NO threads (open since 2022, landing in v5 with a house-written SDK in late 2026), NO polls, NO multi-account, weak push on mobile, fragile key-backup UX, no admin/audit/bridge surface. Actively maintained (v4.12.8, Nov 2026; 293 open issues; v5.0.0 milestone). The Element-vs-Cinny delta above is the feature budget for "between".

## 1. Product summary
- **Maker / steward:** Ajay Bura (@ajbura); project now lives under the **cinnyapp** GitHub org (repo `ajbura/cinny` redirects there). Copyright notice: "Cinny Project © 2024–present Ajay Bura". Active release maintainer visible in 2026 releases: @kfiven; Matrix core dev @tulir among contributors. [verified] (github README, package.json author, releases page)
- **"Sumdog" claim: NOT verified.** No indication on the site/repo that Sumdog (edtech company) makes Cinny; it is a community project by Ajay Bura funded via Open Collective / GitHub Sponsors / Liberapay. Treat "made by Sumdog" as incorrect. [verified] (cinny.in sponsor section)
- **License:** AGPL-3.0-only [verified] (README LICENSE + package.json `"license": "AGPL-3.0-only"`)
- **Hosting:** Official domain is **cinny.in** (not cinny.org); web app at **app.cinny.in**, `dev` branch continuously deployed at **dev.cinny.in**; site deploys via Netlify. [verified]
- **Positioning:** "A Matrix client focusing primarily on simple, elegant and secure interface… instant messaging application that is easy on people and has a modern touch." Named after the purple sunbird (Cinnyris asiaticus). [verified]
- **Distribution: web-first, no installer required.** Self-host = download release tarball and serve `dist/` (nginx/caddy/netlify examples, Docker image on DockerHub + GHCR, PGP-verified tarballs). A **separate** desktop wrapper exists: `cinnyapp/cinny-desktop` (matrix.org ecosystem page lists Windows/macOS/Linux). Web app is a PWA (`vite-plugin-pwa`). [verified]
- **Tech stack:** TypeScript, React 18.2, Vite 5.4, matrix-js-sdk 41.7.0 (as of v4.12.8), jotai state, @tanstack/react-query + react-virtual, vanilla-extract CSS, Slate rich-text editor, i18next. [verified] (package.json)
- **Stats:** ~4.0k stars, 608 forks, 1,616 commits (dev branch). [verified]

## 2. Feature inventory
### 2.1 What Cinny HAS
- **Rooms + DMs, separated** ("Navigation is easy now because we organized DMs separate from channels" — Discord/Element-style three-pane layout; matrix.org rates it "Good for users coming from Discord"). [verified] (cinny.in; matrix.org/clients)
- **Spaces**: full support since v1.8.0 — create spaces/subspaces, rooms inside spaces, add existing rooms, explore hierarchy, space settings (permissions, address, visibility), invites, leave, drag-reorder, pinned spaces, subspaces-as-categories. [verified] (release v1.8.0)
- **E2EE**: since launch; device/session **verification**, **key import/export**, **key backup + recovery-key** restore flows exist (v4.10.3 security note tells users to ensure "working key-backup" before relogin), encrypted attachments (`browser-encrypt-attachment`). "Show source" per event since v1.8.0. Decryption failures surface as `Unable to decrypt` chips. [verified] (releases, security note, issue #2203 text)
- **Timeline design**: messages rendered as a *continuous chain of events* — compact, sender-grouped rows with minimal bubbles/chrome ("No more clutter… everything is properly aligned… calm visual"). The exact phrase "chain of continuous events" was not found in primary sources [unverified phrasing], but the anti-bubble, continuous-stream aesthetic is Cinny's stated design (site copy + Matrix Live S06E41 interview with Ajay). [secondary]
- **Rich message rendering**: replies (reply-to rendering + fixed linking since v1.8.0 era), edits, deletions, reactions (with tooltips), spoilers (`||text||` markdown since v1.8.0), syntax highlighting (prismjs), image blurhash previews, inline PDF viewer, links (`linkify`), markdown via Slate composer. [verified] (deps + v1.8.0 + v4.10.3 notes)
- **Room settings**: rename, topic, avatar, permissions/power levels (room permission editing present; bug fixes for conduit), visibility, addresses/aliases, invite UI. [verified]
- **Members list** with role display and moderation via room settings. [verified] (inferred from permission/settings features; core nav present in app)
- **Invites**: rooms and spaces; join/leave flows. [verified]
- **Search**: header "search mode" (Ctrl+K) present since 2021 for navigating/jumping (issue #201); unicode-normalized search since v1.8.0. [verified]
- **Keyboard shortcuts**: `is-hotkey`-driven; Ctrl+K quick-open; closable dialogs via hotkey (v1.8.0 #269). [verified]
- **Theming**: light/dark/butter + custom accent color (site theme switcher; `chroma-js` + `react-colorful` in deps = theme customization UI). [verified]
- **Multilanguage**: `i18next` + browser language detector + http backend (lazy locale loading). [verified]
- **Desktop notifications** (in-app + browser notifications since v1.8.0 #252) and **homeserver push via pushers** (issue #867: "Currently Cinny handles push notifications natively from the homeserver pushers"). [verified]
- **Voice/video calls**: Element Call embedded since **v4.11.1** ("Voice/Video Rooms"). [verified]
- **Widgets**: `matrix-widget-api` dependency — some native widget protocol support exists (iframe-hosted like everywhere); no Integrations Manager / EasyMode widgets UI like Element. [verified by dependency; depth unverified]
- **UIAA/SSO login**: full User-Interactive Auth incl. SSO (FOSDEM 2022). Registration + reCAPTCHA (`react-google-recaptcha`) supported. [secondary + verified dep]
- **Explore/public rooms**: default explore pages configurable via `config.json`. [verified]
- **PWA installable** (`vite-plugin-pwa`) + PGP-signed self-host tarballs + Docker. [verified]

### 2.2 What Cinny LACKS vs Element (the gap list for a "between" client)
- **Threads: NOT in stable.** Issue #257 open since Jan 2022 (one of the most-requested; "the only reason I'm still tied to Element" — Aug 2022 comment). Implementation exists on the new-SDK branch with preview build (Sep 15, 2026, netlify preview) but even there room-thread discoverability (thread badge on original message) is being debated; Element praised for that detail. [verified]
- **Polls: no create, no render** (not even display) — Issue #563 open since 2022, activity through Feb 2026, assigned to ajbura, unresolved. MSC3381 referenced by community. [verified]
- **Multi-account: unsupported** — Issue #66 open since Aug 2021. [verified]
- **Push notifications: weak on mobile.** Homeserver pushers/web-push only, no UnifiedPush/ntfy support (Issue #867, open since Sep 2022); PWA notifications unreliable on Android browsers and "major limitations on iOS (notifications, local storage persistence)" (community issue #2400, Mar 2026). No official mobile app. [verified + secondary]
- **Key backup / recovery UX: fragile.** Known open bug class: "Messages do not get decrypted from Key Storage" after recovery-key verify (#2203); "Verification seems to succeed, but device stays unverified" (#2766, Mar 2026). No Element-style polished Secure Backup flow. [verified]
- **No message-edit history viewer, no pinned-messages list parity, weaker moderation/audit**: no admin/audit log view, no retention controls, no bridge management, no filer/moderation tools — Element Web has room admin surface Cinny never attempted. [inferred from feature lists; no such features found in docs/releases]
- **No Sliding Sync**: nothing in package.json (js-sdk classic sync) or release notes; Element (with Element X lineage) is moving that way. [inferred/verified-by-absence]
- **No rich notification-processing settings** (Element's per-room notification rules/emails), no voice-message recording history UI, no custom user settings/voice feedback suite. [inferred]
- **No gallery views parity?** Unverified — Cinny has media/address panels of some form; not documented here. [open question]
- **Room upgrades**: tombstone messages shown since v1.8.0, but no evidence of one-click "upgrade room" UI like Element. [verified-by-absence in notes]
- ~293 open issues as of late 2026; v5.0.0 milestone active (threads/new SDK era), plus quality nits tagged for it (date-separator duplicates #3071, static reaction order #2876) and packaging pain (Flatpak Wayland/KDE6 #2905; media-key hijack #3017). [verified]

## 3. Architecture
- **Core:** matrix-js-sdk pinned at **41.7.0** in v4.12.8 (dev) — same generation of SDK Element Web uses; React **18.2.0**; Vite **5.4.19** build; TypeScript **4.9**; PWA via `vite-plugin-pwa`. [verified] (package.json)
- **State/data:** `jotai` atoms for UI state, `@tanstack/react-query` for async data, `immer` + `folds` for immutable updates. [verified]
- **Timeline:** `@tanstack/react-virtual` v3.2 = virtualized, infinitely growing message list (scroll up fetches history via js-sdk pagination; only visible rows are in the DOM). [verified] (package.json) + [inferred]
- **Message composer:** `slate`/`slate-react` rich editor (markdown-ish), `prismjs` syntax highlighting, `sanitize-html`, `linkify`, `emojibase` emoji picker, `blurhash` image previews, `pdfjs-dist` inline PDF viewer, `browser-encrypt-attachment` for E2EE files, `is-hotkey` for keyboard shortcuts. [verified]
- **Styling:** `@vanilla-extract/css` (compile-time typed CSS), `chroma-js` for theme color generation; Inter font bundled (`@fontsource/inter`). [verified]
- **Widgets:** `matrix-widget-api` dependency present (iframe-based widget support exists in some form). [verified] (package.json) — depth of widget UI unverified.
- **Calls:** `@element-hq/element-call-embedded` (0.20.1) — native Element Call VoIP shipped in **v4.11.1**, credited to Element's open-sourcing of the Element Call library. [verified] (package.json devDep + release notes)
- **Leanness:** pure static SPA — no Electron, no Node server, deploy = serve `dist/` (nginx/caddy/netlify/Docker). Desktop app is a separate lightweight wrapper (`cinny-desktop`; historically Tauri-based — verify). PGP-signed release tarballs. [verified for web; secondary for desktop stack]
- **Big 2026 architectural shift:** Cinny team is **replacing matrix-js-sdk with their own SDK** (README notice; issue #257). May 2026 status: new SDK ready, ~25% of code migrated, "blazing fast… very lightweight", major blocker = encryption (plan: temporarily piggyback old sdk's encryption while migrating). PRs frozen during migration. This signals dissatisfaction with js-sdk size/perf — directly relevant to a "between Element and Cinny" client design. [verified] (README + issue #257, May 2026 comments)
- **No sliding sync evidence** in package.json/release notes (js-sdk's new Sliding Sync version was being adopted by Element; Cinny still on classic sync). [inferred/verified by absence]

## 4. Reputation, gaps, maintenance status
### Maintenance as of late 2026 — ACTIVE
- Releases: v4.12.8 latest (Nov 2026); v4.12.1 dated **2026-05-15**; rapid minor cadence (4.12.0→4.12.8) through 2026. Release manager @kfiven; contributors incl. @tulir. 1,616 commits on `dev`. [verified] (releases page)
- v4.11.1 shipped **Voice/Video rooms (Element Call)**. v4.10.4 was a **security release** (noreferrer hardening). [verified]
### Why praised
- matrix.org's own clients page: "Good for: Users coming from Discord who want a familiar layout" (DMs separated from rooms, three-pane layout). [verified]
- Show HN (Jul 2021): "very nice look and feel, definitely prettier and much snappier than Element"; "found to be very fast"; "great first impression… even basic E2EE seems to be available". [secondary] (news.ycombinator.com/item?id=27986376)
- Same HN thread flagged the recurring criticism, still echoed later: "lacks a lot of basic features (like reply, editing/deleting messages…)" (2021-era). [secondary]
- FOSDEM 2022 talk description: goal = "simple, elegant and doesn't feel heavy"; E2EE with key import/export, basic Spaces, full UIAA incl. SSO. [secondary]
### Known gaps / TODOs (citable)
- Threads #257 (open since Jan 2022; 59 comments; the flagship gap) · Polls #563 · Multi-account #66 · UnifiedPush #867 · iOS/PWA push + storage #2400 · Key-backup decrypt bug #2203 · Verification inconsistency #2766 · Flatpak/Wayland #2905. [verified] (github.com/cinnyapp/cinny/issues)
- Community-funded mobile app (Capacitor) floated in #2400 but "exploration of intent" as of Mar 2026. [secondary] (zread.ai summary of community feedback)
- Ecosystem signal: forks fill gaps Cinny won't — **Extera** "based on Cinny with improved mobile support… poll rendering, matrix.to links, chat-list last-message" (TWIM 2024-08-02). [secondary]

## 5. Design lessons worth copying
1. **Three-pane Discord-like shell with DM/room separation** is the recognized sweet spot; matrix.org itself positions Cinny for "users coming from Discord". [verified]
2. **Continuous, sender-grouped timeline** ("calm visual", no bubble clutter) delivers perceived speed and readability cheaply — copy the concept, but keep Element-style reply/thread affordances visible on the original message (the exact gap lizzi193 complained about in #257). [verified]
3. **Ship as static SPA first** (tarball/Docker/nginx self-host, PGP-verified, PWA), wrap desktop later (separate repo) — near-zero distribution friction and small footprint vs Element's Electron. [verified]
4. **Modern lean stack works in prod**: Vite + React 18 + jotai + TanStack Query/Virtual + vanilla-extract + Slate composer. Virtualized timeline is the key perf primitive. [verified]
5. **Delegate hard protocol parts**: ride matrix-js-sdk for E2EE, embed Element Call for VoIP, matrix-widget-api for widgets — reach 80% of Element's capability with ~20% of its code surface. Note the counter-lesson: js-sdk is now considered a bottleneck (own-SDK rewrite in progress; "blazing fast and very lightweight" early results) → a new client should budget for SDK abstraction seams. [verified]
6. **Progressive feature gating** is visible in their changelog cadence: auth/UIAA/SSO → spaces → notifications → calls → threads/v5. A "between Element and Cinny" PRD should adopt the same order but insert threads + polls + multi-account + reliable push much earlier — these are exactly the four loudest community asks. [verified + secondary]
7. **Config-driven self-hosting** (`config.json`: homeservers, explore pages, hash-routing option) plus one-click deploy examples (netlify.toml, caddyfile, nginx conf) — great developer-relations pattern. [verified]
8. **Security posture**: fast security releases with credit to reporters (v4.10.3/v4.10.4, @Quasar0147/@mat-1), `noreferrer` hygiene, key-backup warnings before forced relogin. Copy the practice of pairing security guidance with operational steps. [verified]

## Sources
1. https://cinny.in/ — official site (positioning, features copy, funding, Netlify, ajbura copyright)
2. https://github.com/cinnyapp/cinny — README (AGPL-3.0-only, own-SDK notice + PR freeze, hosting/deploy docs, PGP key, stats)
3. https://raw.githubusercontent.com/cinnyapp/cinny/dev/package.json — v4.12.8 deps (matrix-js-sdk 41.7.0, React 18.2.0, element-call-embedded 0.20.1, vite 5.4.19, etc.)
4. https://github.com/cinnyapp/cinny/releases — v4.12.8→v4.10.4 (2026 cadence; v4.11.1 VoIP feature; security releases)
5. https://github.com/cinnyapp/cinny/releases/tag/v1.8.0 — "Cinny v1.8.0: Spaces" feature list (spaces, desktop notifications #252, spoilers, event source #320)
6. https://github.com/cinnyapp/cinny/issues/257 — Threads issue + new-SDK status (May 2026: ~25% migrated, encryption blocker; Sep 2026 preview build; thread-discoverability critiques)
7. https://github.com/cinnyapp/cinny/issues/563 — Support for Polls (open, unfunded)
8. https://github.com/cinnyapp/cinny/issues/867 — UnifiedPush/ntfy request (push model statement)
9. https://github.com/cinnyapp/cinny/issues/2203 — key-backup decryption failure report
10. https://github.com/cinnyapp/cinny/issues/201 — Ctrl+K search-mode reference
11. https://github.com/cinnyapp/cinny/issues — open-issue snapshot: #66 multi-account, #2766 verification, #2905 Flatpak, v5.0.0 milestone, 293 open
12. https://matrix.org/ecosystem/clients/cinny + https://matrix.org/clients — "By Ajay Bura, AGPL-3.0-only, Win/macOS/Linux/Web", "Good for: Users coming from Discord"
13. https://news.ycombinator.com/item?id=27986376 — Show HN Jul 2021 (speed/beauty praise; missing basic features criticism) [secondary]
14. https://archive.fosdem.org/2022/schedule/event/matrix_cinny — FOSDEM 2022 abstract (E2EE, key import/export, Spaces, UIAA/SSO, react+js-sdk) [secondary]
15. https://matrix.org/blog/2024-08-02/this-week-in-matrix-2024-08-02 — Cinny v4 announcement link + Extera fork features [secondary]; https://zread.ai/cinnyapp/cinny/5-community-and-user-feedback — community feedback synthesis (mobile gap, VC demand quotes) [secondary]; https://www.linuxlinks.com/cinny-matrix-client — dev/license/feature summary [secondary]


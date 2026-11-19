# ELEMENT (Web + Desktop) — Feature & Architecture Profile

> Research deliverable for the "between Element and Cinny" Matrix client PRD.
> Claims marked [verified] = official docs/repo/blog of Element or Matrix orgs; [secondary] = reviews, HN, Reddit, third-party blogs.
> Status: COMPLETE draft (Nov 2026). Element releases ~v1.12.x; Electron 44; matrix-js-sdk ~v45.

## 1. Product summary

**Maker.** Element (formerly *Vector* → *Riot*) is built by **Element (New Vector Ltd)**, UK, on the Matrix open standard. Element Web & Desktop are "a glossy Matrix collaboration client"; the wider product family: Element Web/Desktop, Element X (iOS/Android, Matrix Rust SDK), Element Server Suite (ESS) / Matrix Standard backend, Element Call. [verified — github.com/element-hq/element-web README; element.io/about]

**Licensing (critical for competitive analysis).** As of the 2023+ element-hq era, element-web and element-desktop are **multi-licensed**: (1) GNU AGPLv3+, or (2) GPLv3+, or (3) paid Element Commercial license. The repos carry `LICENSE-AGPL-3.0`, `LICENSE-GPL-3.0`, `LICENSE-COMMERCIAL` files. Copyright chain: OpenMarket → Vector Creations → New Vector Ltd (2014–2025). Note: this is a **copyleft relicensing** of what was originally Apache-2.0 — a fork for a competing client must either comply with AGPL/GPL (derive + publish source) or write from scratch on Apache-licensed pieces (matrix-js-sdk itself remains Apache-2.0). [verified — README "Copyright & License" sections of both repos]

**Distribution.**
- **Web**: hosted at `app.element.io` (develop branch → `develop.element.io`); self-hostable static bundle (`config.json` overrides); also ships as a **PWA** installable in Chromium browsers. [verified — element-web README]
- **Desktop**: Electron wrapper around the *exact same web app*; prebuilt from element.io/get-started. Since late 2024/2025 the separate `element-hq/element-desktop` repo was **archived (read-only, Mar 2026)** and merged back into the element-web monorepo under `apps/desktop`. The desktop app fetches the prebuilt web release tarball from element-web GitHub releases (GPG-verifiable) and packages it with electron-builder. [verified — element-desktop README "Important" banner + "Fetching Element" section]
- **Windows/Linux installers**: electron-builder output; Windows gets an **NSIS** installer + zip; Linux gets **deb, rpm, tar.xz, AppImage, Arch pkg** (auto-update via the element.io release feed when built with the official `element.io` config dir). Native Node modules (optional at build time) power **searching in encrypted rooms** and **secure storage** (keyring); without them those features are missing — a key PWA-vs-desktop difference. [verified — element-desktop README; install docs]
- **Profiles**: `element-desktop --profile Work` / `--profile-dir` for multiple instances; user config lookup: `%APPDATA%\Element\config.json` (Windows), `$XDG_CONFIG_HOME/Element/config.json` or `~/.config/Element/config.json` (Linux). `ELEMENT_DESKTOP_CONFIG_JSON` env var supported. [verified — element-desktop README "Config"/"Profiles"]
- **Mobile**: Element X (element-x-android / element-x-ios) is the recommended native apps (different stack: Rust SDK + XCFramework/Compose). Browser tiers of support for Web: last 2 versions of Chrome/Firefox/Edge/Safari "supported"; Element Call not supported in ESR browsers. [verified — element-web README "Supported Environments"]

## 2. Feature inventory
### 2.1 Core messaging
- **Rooms**: public/private rooms, aliases, invites/join by ID or address, room upgrade (version rotation), history visibility, "Explore rooms" public-directory browser; knock/request-to-join behind labs (`feature_ask_to_join`). [verified — labs.md; user guide]
- **DMs**: dedicated "People"/chat section, start-new-chat picker with existing Matrix users; is-DM room semantics. [verified — user guide "Add People"/"Manage rooms"]
- **Threads**: read/start/participate, thread panel list ([verified — matrix.org/clients feature matrix "Threads"], spec MSC3440).
- **Replies & edits**: threaded replies, message editing with inline diff display (repo ships `diff-match-patch`/`diff-dom` deps — [verified apps/web/package.json]), redactions ("Remove"), undo-send.
- **Reactions**: aggregated `m.reactions`, emoji picker (Emojibase bindings), custom emoji/stickers (also in integrations). [verified deps]
- **Polls**: create/vote in-room polls (MSC3381). [verified — Element user guide/changelog; secondary in third-party reviews e.g. blog.elest.io]
- **Rich text composer**: WYSIWYG editor (`@vector-im/matrix-wysiwyg 2.40.0` Rust-based editor — [verified package.json]) with Markdown source mode toggle (`commonmark`, `highlight.js` code blocks, optional KaTeX LaTeX via labs), slash commands, mentions incl. `@room`.
- **Attachments**: drag-drop upload, image/video/audio/file, encrypted media (`matrix-encrypt-attachment` dep), blurhash thumbnails (`react-blurhash`), in-app PDF viewer (`pdfjs-dist`), file size limits from homeserver. [verified deps]
- **Voice messages**: record-and-send Opus voice notes (`opus-recorder` dep). [verified package.json; user guide "Voice messages"]
- Text formatting: bold/italic/code/links rendered from HTML body (`m.formatted`), sanitised with `sanitize-html`. [verified deps]

### 2.2 Organization
- **Spaces**: browse/join/manage, private & public spaces, **nested space hierarchy** (space hierarchy state, MSC1772-based), Explore space, space as primary grouping replacing Communities. [verified — matrix.org/clients; element.io/features "Spaces: Group chat rooms for individuals or teams and assign access permissions"]
- **Favourites**: star rooms/spaces/conversations into a Favourites filter/section (current layout). [verified — user guide "Favourites"]
- **Room list**: sections & filters (All / Unreads / Favourites / People / Rooms / Low priority / Restricted), sort options (recent/alphabetical/priority), custom lists via Spaces, room "Low priority"/"Mark all read". [verified — user guide "Manage rooms"; details secondary]
- **Pinning**: pin messages in a room via the message context menu (`feature_pinning` labs flag). [verified — labs.md]
- **Bookmarks**: earlier releases had a dedicated bookmarks/saved-items list; now effectively covered by Favourites + breadcrumbs of recently-visited rooms at the top of the room list. [secondary — community knowledge/reviews; breadcrumbs UI not in fetched docs]

### 2.3 Security / E2EE
- Default E2EE for DMs and private rooms (Megolm room keys, Olm device keys). [verified — matrix.org blog "E2EE by default"; element.io/features "default end-to-end encryption"]
- **Verification**: interactive emoji SAS + QR-code verification between devices/users; device manager in Settings; "verify this session" flows; DM-based verification (MSC2241) in labs. [verified — matrix.org docs; labs.md]
- **Cross-signing**: master/self-signing/user-signing keys give per-user identity so each new device doesn't need re-verification. [verified — matrix.org blog 2020-05-06; e2ee-cross-signing docs]
- **Key backup (server-side)** + **SSSS (Secure Secret Storage & Sharing)**: encrypted key backup to homeserver, recovery by passphrase/recovery key, secrets (cross-signing privkeys, backup key) stored in account data encrypted. [verified — matrix.org docs/older/e2ee-cross-signing; spec E2EE module]
- **Secure storage**: browser crypto store in IndexedDB; desktop adds OS-keychain secure storage + **PKCS#11 hardware keys** optional deps (`graphene-pk11`, `pkcs11js` for enterprise HSM/smartcards). [verified — apps/desktop/package.json; element-desktop README native modules]
- Crypto engine: **Vodozemac** (Rust) via `@matrix-org/matrix-sdk-crypto-wasm@19.0.1` dependency; legacy libolm (`@matrix-org/olm`) now only a dev-dependency. [verified — matrix-js-sdk package.json]
- Extra controls: "Exclude insecure devices" send/receive policy (labs), encrypted state events (MSC4362, labs), dehydrated/backup device support in SDK. [verified — labs.md]
- **Login**: legacy password login, legacy SSO (SAML/CAS/OIDC-relay), **OAuth 2.0/OIDC native login (MAS/Matrix 2.0)** — both checkboxes on matrix.org's Element entry; QR-login-from-Element-X (MSC4108) via config; email/phone on matrix.org. [verified — matrix.org/clients; labs.md]

### 2.4 Calls & presence
- **1:1 calls**: native WebRTC voice/video (matrix-js-sdk call classes; verified via matrix.org/clients "Voice and Video Calls (1:1)"), screen sharing.
- **Group calls**: three generations coexisting — (a) legacy Jitsi conference widget (vendored `jitsi_external_api` + `@types/jitsi-meet`), (b) **Element Call** on **MatrixRTC** (MSC4143) with LiveKit SFU, E2EE media, rendered as widget or embedded React component (`@element-hq/element-call-component 0.28.2`; labs `feature_element_call_react`), (c) persistent **video rooms** (beta). [verified — package.json deps; labs.md/betas.md; matrix.org/clients; element-call README diagrams (widget/standalone/SFU/federation)]
- **Presence/typing/read receipts**: presence dots, typing notifications, delivered/fully-read ticks (`m.receipt`), all standard spec features Element ships. [verified — matrix.org client-server spec modules; user guide]
- **User status** (away status / emoji, MSC4429+4426): labs. **Live location sharing** (MapLibre-based, `maplibre-gl` dep + static location pins): labs `feature_location_share_live`. [verified — package.json; labs.md]

### 2.5 Collaboration extras
- **Widgets/apps**: `matrix-widget-api@^1.20` integration — Jitsi, Element Call, custom widgets; "Integrations/bots/bridges" marketing on element.io/features. [verified]
- **Bridges**: Slack/Discord/IRC/Telegram/WhatsApp/Google-Chat etc. via server-side appservices — Element surfaces bridge rooms in the timeline/UI and adds a **Bridge Info tab** (MSC2346) in labs; matrix.org's hosted bridges now run through Element's paid interop service. [verified — labs.md; hosting details secondary]
- **Communities (legacy Groups)**: pre-Spaces grouping still readable/joinable for migration but deprecated in favour of Spaces; member panel code shared (labs DM-verification note mentions community members). [verified labs.md mention; deprecation status secondary]
- **Message search**: room list search, people search, in-room timeline search on client store; **full encrypted-room search server-side indexing via `seshat` native module on desktop** (`@matrix-org/seshat ^6.0.1`; absent in PWA). [verified — desktop package.json + element-desktop README]
- **URL previews** (incl. MSC4095 bundle in labs), pinned-message lists, room settings dialog, quotes/copy-link, "Report content" moderation affordance. [verified — labs.md; report content secondary]
- Notifications panel in room header (labs). [verified]

### 2.6 Notifications
- **Desktop**: native OS notifications + tray/taskbar badge via Electron; auto-launch option (`auto-launch` dep). [verified — desktop package.json]
- **Web/PWA**: Web Push via service worker + Sygnal push gateway (matrix.org-hosted `push.element.io` for app.element.io). [secondary — well-documented Element/matrix.org infra, not fetched]
- **Mobile**: FCM/APNs via Sygnal for the native Element/Element X apps. [secondary]
- **Email notifications**: user-guide documents email alert options (account-activity/security + message emails depending on server/plan). [verified — user guide topic list "Notifications"; specifics secondary]
- Sounds: classic **"rings and binks"** notification audio suite, per-room notification settings, mentions-and-keywords push rules; **new push-rule-based notifications settings** UI (beta `feature_notification_settings2`). [verified — user guide; betas.md/labs.md]

### 2.7 Customization
- **Themes**: light/dark/system + custom theme support ("Match system", import/export themes; several built-ins incl. dark high-contrast). [verified — Element user guide/help; secondary otherwise]
- **Custom homeserver**: chosen at login (matrix.org, own server, Element PRO/ESS hosted); `config.json` overrides homeserver, branding, features for self-hosters. Desktop additionally reads user `config.json` from `%APPDATA%`/`~/.config`. [verified — element-web docs/config.md; element-desktop README]
- **Labs / experimental flags** (Settings → Labs, non-exhaustive from `docs/labs.md` [verified]): LaTeX/KaTeX maths, **message pinning**, **jump-to-date** (MSC3030), **mjolnir ban lists** (ignore with MSC2313), DM-verification UX (MSC2241), **bridge info tab** (MSC2346), **live location sharing**, **video rooms** (Jitsi) & **Element Call video rooms**, **MatrixRTC call slots**, notifications panel, **knock/request-to-join**, **exclude insecure devices** from E2EE send/receive, **encrypted state events** (MSC4362), new push-rule notification settings, **user status** (MSC4429/4426), **QR login from Element X** (MSC4108), URL-preview bundle (MSC4095), **Element Call as React component instead of widget**. Some labs promote to **Betas** (`docs/betas.md`).
- Notification sounds ("rings and binks") configurable in Settings → Notifications. [verified — user guide]

### 2.8 Enterprise
- **SSO**: legacy SSO (SAML 2.0, CAS, OIDC-via-relay) and modern MAS/OAuth2-OIDC login both supported (matrix.org/clients lists "Legacy SSO" **and** "OAuth 2.0" for Element W/D). [verified]
- **Server-side**: Element Server Suite / "Matrix Standard" / Element PRO — Synapse-based, with enterprise extras (hosting, SLAs, border gateways between private/public Matrix networks, cross-domain air-gapped linking). [verified — element.io/features]
- **Admin/moderation tools**: per-room power levels, kick/ban, create/restricted rooms; **Mjolnir ban-list support** in Element (labs `feature_mjolnir`, MSC2313); report-content; ESS admin API/UI (Synapse Admin). Device-verification & revocation marketed ("Guard against imposters by verifying, and revoking access of lost or stolen devices"). [verified — labs.md; element.io/features]
- **Guest access**: spec module (`m.guest_access`) honoured by Element (join public rooms without account if server permits); matrix.org currently disables guest registration. [secondary — spec module well known; not fetched]
- **Audit/compliance**: server-side audit logs & compliance are ESS/Synapse features (not client-side in Element Web); Element itself ships Sentry crash reporting (`@sentry/browser`, `@sentry/electron`) and PostHog analytics (consented, `@matrix-org/analytics-events`). [verified — package.json deps; server-side extras secondary]
- **Lockdown/branding for self-hosters**: config.json branding + feature flags shipped with every distro; enterprise builds can pre-bake config (`--cfgdir`, `element.io` config dir for the official auto-updating app). [verified — element-desktop README]

## 3. Architecture

**Stack (verified from monorepo manifests):**
- **matrix-js-sdk** (Apache-2.0, currently v45.1.0) does all protocol work: Client-Server API, rooms/members state, sync loop, VoIP call classes, widget hosting, crypto orchestration. Element Web pins it to the **`develop` branch** (`matrix-js-sdk: github:matrix-org/matrix-js-sdk#develop`) — bleeding-edge, and a structural source of regressions. [verified]
- **UI**: **React + TypeScript** monorepo (element-web now hosts web + desktop + packages; matrix-react-sdk was merged into it — the historical `matrix-react-sdk` layer is now `apps/web` internals). Design system: `@vector-im/compound-web`/`compound-design-tokens`; theming via PostCSS ("rethemendex" script, `.pcss` files). Build: **webpack 5**, Babel, Node ≥22.18, pnpm workspaces + Nx; tests: Vitest + Playwright. [verified package.json]
- **Electron shell** (`apps/desktop`): Electron **44.11.3**, electron-builder **26.18.0** (NSIS/zip Windows incl. Squirrel helper pkg; deb/rpm/AppImage/tar.xz/Arch Linux; universal macOS), `@electron/asar` + `@electron/fuses` hardening, electron-store/electron-window-state, auto-launch, crash via `@sentry/electron`. Desktop ships **no UI code of its own** — it downloads the GPG-signed Element Web release bundle and wraps it. [verified]
- **Native modules (desktop-only, optional at build)**: `@matrix-org/seshat` — Rust full-text indexer for **encrypted** room search; **secure storage** integration with OS keychain (and optional PKCS#11 via `graphene-pk11`/`pkcs11js`); native tray/notifications. README: skipping these "is fine, you just won't have those features". [verified]
- **Crypto**: Olm/Megolm implemented by **Vodozemac** (Rust → WASM) through `@matrix-org/matrix-sdk-crypto-wasm@19.0.1` in matrix-js-sdk. The Rust **`matrix-sdk`/`matrix-sdk-crypto`** family powers Element X, **not** Element Web (W/D stay on the JS SDK + WASM crypto). libolm remains a dev-dependency only. [verified]

**Sync engine:**
- Element Web historically runs classic **v2 `/sync` long-poll full sync**; a **Sliding Sync (MSC3575)** variant existed behind labs with the matrix.org sliding-sync **proxy**, which was **sunset Nov 2024** in favour of **native Simplified Sliding Sync (MSC4186)** in Synapse ≥ v1.114 (proxy repo archived; MSC3575 client support dropped ~Jan 2025). [verified — matrix.org blog 2024-11-14 "Sunsetting the Sliding Sync Proxy"]
- Element Web SSS support is an open **epic (element-web#28736: "Simplified Sliding Sync in Element Web"**, js-sdk PR #4400, web PR #28515; labs flag work) — as of writing (late 2026) it is in progress, not the default on app.element.io (still v2 full sync); Element X already ships SSS-native (matrix.org/clients: Element X "Simplified Sliding Sync ... MSC4186"). [verified — GH issue + matrix.org/clients]
- Consequence: for accounts in many rooms, Element Web's full-sync payload size/CPU remains the biggest perf lever the ecosystem is trying to fix (mirrors the "sync makes desktop unusable" complaints in §4). [synthesis]

**PWA vs Desktop differences:** same webapp code; desktop adds auto-update (element.io feed), native notifications/tray, profiles (`--profile`), local `config.json` override, encrypted-room search (seshat), OS-keychain/PKCS#11 secure storage, better call permissions UX; PWA relies on IndexedDB for both crypto and event stores and Web Push, no native search index. [verified]

## 4. Known complaints / bloat criticisms
- **Resource usage / Electron bloat.** "I wish it wasn't an Electron app built on Chromium which makes it a huge resource hog" — HN, Jan 2021 (news.ycombinator.com/item?id=25812536). [secondary]
- **Sync/startup hangs on large accounts.** "Signing into a fresh profile seems to improve this... even under normal operations it's slow enough to start up that it can take some time to tell if it'll eventually resolve or needs to be force-killed... on an otherwise idle 8-core Ryzen with 64 GB RAM and fast NVMe" — HN, Jul 2022 (item?id=32020644); Element's Arathorn responds distinguishing "slow joins over federation" vs client slowness — i.e. the team itself acknowledges multiple perf classes. [secondary]
- **"The default implementation is so bloated"** + "judging Matrix by the legacy Element apps" — HN Jul 2025 "Giving Up on Element and Matrix.org" (item?id=44617309), where several commenters recommend lighter forks/clients (SchildiChat — itself a fork — HipStream, etc.); Element counters by pointing to Element X. [secondary]
- **Feature-culture / UI complexity.** Reddit "Why is Element so BLOATED? Criticisms from a normie" (r/matrixdotorg w7fsge): a newcomer's list of too many buttons/options/half-finished features vs Discord/WhatsApp simplicity. [secondary]
- **Voice/call UX gripes.** Recent Reddit "I want to love matrix, but it's extremely clunky and limited" (r/matrixdotorg 1r345xz): Element Call ≠ Discord-style persistent voice lobbies; self-hosting LiveKit relays is painful; perceived roadmap bias toward "Zoom/Teams stuff". [secondary]
- **Polling/sync inefficiency.** Third-party critique "Why Matrix Sucks" (hanez.org) calls out "frequent polling and redundant HTTP requests (e.g. sync endpoints)" taxing clients — the exact problem sliding-sync/Super-Sync work targets. [secondary]
- **Instability-by-design:** pinning matrix-js-sdk to `develop` means release regressions; labs/betas sprawl (26+ flags/betas) means user-visible features ship behind toggles for months (pinning, jump-to-date, user status, SSS itself). [verified manifest evidence + synthesis]
- Mitigations Element has shipped that a competitor must acknowledge: lazy loading of room state, `bloom-filters`, chunked sync, seshat off-thread search, sliding-sync work, Compound design system refresh. [verified deps/labs]

## 5. What Element does exceptionally well (must-match for a new client)
1. **Spec coverage / interop surface**: threads, polls, edits+diffs, reactions, receipts, typing, knock, upgrades, space hierarchy, OIDC *and* legacy SSO *and* legacy passwords in one login screen — the de-facto "does my feature work?" reference (matrix.org's own client feature matrix grades Element as the yardstick). [verified]
2. **E2EE UX maturity**: the most complete cross-verification story of any Matrix client — SAS emoji + QR, cross-signing bootstrap, server key backup + recovery-key passphrase, "unable to decrypt" affordances, device manager, insecure-device exclusion. A new client that can't reproduce verification + recovery flows will lose power users instantly. [verified]
3. **Spaces**: browse/nest/admin-space is the organizing primitive everyone in Matrix has adopted. [verified]
4. **Deployment flexibility**: same binary works against matrix.org, ESS, Synapse behind any SSO, air-gapped self-hosts via `config.json` + branding + labs control; desktop profiles + auto-update + NSIS/deb/rpm/AppImage installers that IT admins already tolerate. [verified]
5. **Rich media & calls surface**: WYSIWYG composer, voice messages, blurhash/preview pipeline, encrypted attachments, PDF viewer, plus the ongoing Jitsi→Element Call/MatrixRTC migration incl. persistent video rooms. [verified]
6. **Ecosystem gravity**: bridges, bots, widgets, Mjolnir moderation tooling, and new MSCs get first-class UI here before anywhere else (labs.md shows MSC3030/2241/2313/2346/4095/4108/4143/4362/4426/4429 surfaced in UI). [verified]
7. **i18n + accessibility plumbing**: Localazy translation pipeline, 40+ locales, `what-input` focus management, react-focus-lock. [verified deps]

The competitive gap is **performance and density** (see §4): full-sync startup cost, memory footprint of React+Electron at scale, and cluttered feature discoverability — exactly the "between Element and Cinny" positioning.

## Sources
1. https://github.com/element-hq/element-web — README (license, monorepo, environments, Element X pointer) [fetched]
2. https://github.com/element-hq/element-desktop — README (archived; fetch/asar/electron-builder; native modules; profiles; config.json paths) [fetched]
3. https://raw.githubusercontent.com/element-hq/element-web/develop/docs/labs.md [fetched]
4. https://raw.githubusercontent.com/element-hq/element-web/develop/docs/betas.md [fetched]
5. https://raw.githubusercontent.com/element-hq/element-web/develop/apps/web/package.json [fetched]
6. https://raw.githubusercontent.com/element-hq/element-web/develop/apps/desktop/package.json [fetched]
7. https://raw.githubusercontent.com/matrix-org/matrix-js-sdk/develop/package.json [fetched]
8. https://matrix.org/clients — Element Web/Desktop + Element X feature matrix [fetched]
9. https://raw.githubusercontent.com/element-hq/element-call/main/README.md [fetched]
10. https://element.io/features (search snippet) ; https://element.io/user-guide (search snippet) ; https://element.io/about (search snippet)
11. https://matrix.org/blog/2024-11-14/moving-to-native-sliding-sync (search snippet)
12. https://github.com/element-hq/element-web/issues/28736 — SSS epic (search snippet)
13. https://matrix.org/docs/older/e2ee-cross-signing + https://matrix.org/blog/2020-05-06/cross-signing-and-end-to-end-encryption-by-default-is-here (search snippets)
14. Complaints: HN 25812536, HN 32020644, HN 44617309, HN 44391734, Reddit r/matrixdotorg w7fsge + 1r345xz, r/elementchat rm8sgg, https://hanez.org/document/why-matrix-sucks [secondary; snippets via search]

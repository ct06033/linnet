# Linnet

A Matrix chat client that sits **between [Element](https://element.io) and [Cinny](https://cinny.in)** —
calmer than Element, more capable than Cinny. Desktop-first for **Windows and Linux**, built as a
vanilla TypeScript renderer inside an Electron shell.

> **v0.2.0** is the big capability wave: **1:1 video calls and screenshare**, and group
> calls wired to a self-hosted Element Call + LiveKit stack (widget-based stage; a DNS/cert
> item gates public dial-in, LAN works today). The room list grew up — **favourites**
> (standard `m.favourite` tags, Element-interop), collapsible nested spaces, DMs inside
> group views, member counts, avatars everywhere, room topics. Chat got date breaks,
> per-message timestamps, a dark scrollbar, and **privacy-facade inline YouTube playback**.
> Room settings finally got their panel, panes are **resizable** (persisted), and profile
> editing (display name/avatar) landed. Two reliability fixes ride along: encrypted stores
> are now **per-session** (re-login after sign-out could hard-fail with
> "account in the store doesn't match" — root-caused in the rust-crypto IndexedDB store,
> fixed + wiped on logout), and Linux icons install correctly (broken hand-made `.desktop`
> `Icon=` path). Installers remain unsigned (see Honest limits below). Feedback welcome in
> [Issues](https://github.com/ct06033/linnet/issues).

## Download

Grab an installer from the [latest release](https://github.com/ct06033/linnet/releases/latest):

| Platform | File | Install |
|---|---|---|
| Windows 10/11 x64 | `Linnet-0.2.0-win-x64.exe` | NSIS installer (per-user, choose folder) |
| Debian/Ubuntu x64 | `Linnet-0.2.0-linux-x64.deb` | `sudo apt install ./Linnet-0.2.0-linux-x64.deb` |
| Any Linux x64 | `Linnet-0.2.0-linux-x64.AppImage` | `chmod +x`, run |

## What's in (MVP)

- **Accounts** — password + legacy SSO login (UIAA redirect with IdP buttons), multiple accounts,
  sign out all other sessions, session list with per-device revoke
- **Messaging** — rooms, DMs, threads, polls, reactions, edit/redact, slash commands, command
  palette (Ctrl+K), read receipts, notification engine (per-room all/mentions/mute + keywords,
  desktop notifications, invite join/decline)
- **E2EE done properly** — Megolm via rust crypto, cross-signing bootstrap, SAS emoji
  verification (verified live against a second device), incoming verification prompts, secure
  message backup (recovery key + passphrase, key storage in the OS keychain via `safeStorage`)
- **Organization** — spaces rail with real `m.space` graph, room settings (name/topic/avatar,
  permissions, members), unread pills
- **Media & calls** — encrypted images/files/voice messages, image lightbox, authenticated
  media; 1:1 voice calls (ring, answer, hang up, mute)
- **Platform** — light/dark/system theming + accent colors, screen-reader labels, skip link and
  focus-trapped dialogs, native notifications, Linux unread badge, external links open in your
  browser

## Honest limits (v0.1)

- **Unsigned installers** — SmartScreen / apt will warn you. No code-signing cert yet.
- **1:1 calls only** — group calls, screen share are next (the WebRTC plumbing is proven).
- **No passkey/MAS login yet** — legacy SSO redirect works; OAuth 2.0/MAS + new-session consent
  is P1 per the [PRD](docs/prd.md).
- **Linux badge** works on Unity/GNOME docks that implement `setBadgeCount`; Windows has no
  taskbar badge API (unread counts still show in-app).
- **Placeholder icon**, perf budget (PRD §7) not yet published against a baseline.

## Build from source

Requirements: Node ≥ 22, pnpm 12, Linux (any arch) for full packaging — Windows installers
cross-build fine from Linux x86_64.

```sh
pnpm install
pnpm -r build          # core → app renderer → desktop main/preload
pnpm --filter @linnet/app test   # 190 renderer tests + core suites
cd apps/desktop && npx electron-builder --linux --win --x64
# artifacts land in apps/desktop/dist/
```

To run headless during development: `pnpm --filter @linnet/app dev` serves the renderer;
`pnpm --filter @linnet/desktop dev` launches Electron against it.

## Layout

- `packages/core` — matrix-js-sdk seam: SessionManager, accounts store, relay + fake homeservers
  for tests (everything protocol sits behind this boundary)
- `packages/app` — React renderer: 3-pane shell, messages, threads, polls, media, spaces,
  security center, notifications, calls, theming, a11y
- `apps/desktop` — Electron shell (sandboxed renderer, contextBridge preload, safeStorage
  secrets), electron-builder config
- `docs/prd.md` — the locked spec this repo implements; `docs/research/` — the Element/Cinny
  audit it came from

## License

AGPL-3.0-only. No analytics, no telemetry — see PRD §8 for the full privacy position.

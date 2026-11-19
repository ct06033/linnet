# Linnet v0.1.0 — first MVP release

The whole MVP from the PRD is in this first release: end-to-end E2EE with
cross-signing and SAS verification, threads, polls, spaces, encrypted media
and voice messages, 1:1 voice calls, notifications, SSO + password login,
theming and a real accessibility pass.

## Installers

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 x64 | `Linnet-0.1.0-win-x64.exe` | NSIS per-user installer. **Unsigned** — SmartScreen will warn; that's expected until we add code signing. |
| Debian/Ubuntu x64 | `Linnet-0.1.0-linux-x64.deb` | `sudo apt install ./Linnet-0.1.0-linux-x64.deb` |
| Any Linux x64 | `Linnet-0.1.0-linux-x86_64.AppImage` | `chmod +x` and run |

## Highlights

- **Security that actually works**: Megolm E2EE (rust crypto), cross-signing bootstrap,
  SAS emoji + QR verification with a *second-device live-tested* flow, secure message
  backup (recovery key / passphrase), secrets in the OS keychain, session list with
  per-device revoke and "sign out all other sessions".
- **Messaging**: rooms, DMs, threads, polls, reactions, edits/redactions, slash
  commands, Ctrl+K palette, read receipts, typing.
- **Media & calls**: encrypted images/files/voice messages, authenticated media,
  image lightbox, 1:1 voice calls.
- **Organizing**: real `m.space` support (rail, sections, room links), full room
  settings panel.
- **Notifications**: per-room all/mentions/mute + keyword rules, desktop
  notifications, invite join/decline inline.
- **Login**: password + legacy SSO (IdP buttons, browser bounce with `loginToken`).
- **Platform**: light/dark/system themes + accent colors, screen-reader labels,
  skip link, focus-trapped dialogs, external links in OS browser.

## Known limits (honest list)

- Unsigned binaries (Windows SmartScreen prompt; no apt repo yet)
- 1:1 calls only — group calls & screen share next
- Legacy SSO only — MAS/OAuth 2.0 + passkeys planned (PRD §8)
- Placeholder app icon
- Linux taskbar badge depends on dock support (`setBadgeCount`)

Built from tag `v0.1.0`. Renderer: 161 tests, core: 25 — all green at release time.

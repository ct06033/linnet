# Linnet — Dev-Stage Exit Test Plan (QA-PLAN v0.1)
Date: 2026-11-18 · Repo target: `docs/qa/dev-exit-test-plan.md` (copy in after wave-1 merge)
Authority: PRD v0.2 + approved §8 security ladder (2026-11-18).

---

## 0. How to run this

- Each case has an ID, priority (**B**=blocker, **M**=major, **m**=minor) and an evidence column. Log results in the gate task as a table: `ID | PASS/FAIL/BLOCKED | evidence link (screenshot, trace, CI run, commit)`.
- **Severity rubric (security findings):** Critical = remote code exec / key theft / message plaintext exposure without user action. High = auth bypass, verification bypass, XSS with stored payload, token leak to disk/logs. Medium = UI info disclosure, DoS with user interaction, missing hardening with credible exploit path. Low = defense-in-depth gaps. Map CVSS ≥9.0→Critical, 7.0–8.9→High, 4.0–6.9→Medium.
- **Rules of engagement for pen tests:** attack only our dev homeserver (local Synapse), our dev deploys, and local client instances. Never point tooling at matrix.org or third-party servers. Fuzz payloads stay in private test rooms.

## 1. Environment & fixtures

| Fixture | Spec |
|---|---|
| HS-A | Local Synapse (latest stable), `e2e_enabled`, federation off — primary functional server |
| HS-B | Second local Synapse, federation **on** between A↔B — cross-server identity/room tests |
| Accounts | `alice` + `bob` (regular), `mallory` (attacker, member of rooms alice/bob join), each with 3 devices |
| Seeded perf account | 500 rooms, ≥10k events in target timelines (PRD §7 harness) |
| Recovery scenario | Fresh account with key backup + SSSS on HS-A, client wiped → restore path |
| Hostile-HS proxy | mitmproxy script that mutates/withholds/delays `/sync`, `/keys/*`, `/sendToDevice` responses |
| Targets | Win 10 x64 + Win 11, Linux x64 + arm64 (deb/rpm/AppImage), hosted web build (Balthazar dev) |
| Web deploys | self-host-simple (A posture, static dist/) **and** hosted-secure (B, auth-proxy mode on Balthazar) — §3 gates run against **both** when both are public |

---

## 2. Functional test cases (MVP scope, PRD §6)

### 2.1 Auth & accounts
| ID | Case | Steps (abridged) | Expected | P |
|---|---|---|---|---|
| FA-01 | Password login, custom homeserver | Enter full server name on HS-A | Login, device created, session persisted | B |
| FA-02 | `.well-known` discovery | Use bare domain of HS-A | Resolves to client/server URLs, login works | B |
| FA-03 | Bad credentials | Wrong password ×5 | Clear error, no crash, no token persisted, UIAA handled | M |
| FA-04 | Legacy SSO | UIAA redirect flow against test OIDC-relay (mock) | Completes or fails with actionable error; no token in URL bar/history post-callback | M |
| FA-05 | Multi-account isolation | Alice + Bob signed in; switch active view | Stores/crypto/notifications isolated; room data never cross-renders; logout of one leaves other intact | B |
| FA-06 | Session revoke remotely | Revoke device via Element/API on HS-A | Client detects, shows re-auth prompt, cannot keep writing with dead token | M |
| FA-07 | Device/session management UI | List + rename + revoke own sessions from client | Matches server state | M |

### 2.2 Messaging core
| ID | Case | Expected | P |
|---|---|---|---|
| FM-01 | Send / edit / delete(redact) / undo-send | All round-trip incl. in encrypted rooms; redaction removes content everywhere | B |
| FM-02 | Threads: reply-in-thread, count badge on parent, thread panel | Consistent counts across devices after reload | B |
| FM-03 | Reactions | Aggregated, toggle off, survive reload, work encrypted | M |
| FM-04 | Mentions incl. @room guard | Highlight + notification; @room shows confirm step | M |
| FM-05 | Read receipts + typing | Render both ways; no sync storm at 500 rooms | m |
| FM-06 | Markdown composer + rich toggle, code highlight, spoilers, emoji shortcodes, slash commands | Round-trip `m.text`→`m.notice`/`m.html`; spoiler click-reveal; /me, /shrug, joinpart etc. | M |
| FM-07 | Polls (MSC3381) | Create/vote/change vote/results end-state; poll in encrypted room | B |
| FM-08 | Attachments incl. **encrypted files** | Drag-drop upload/download/open; encrypted rooms upload→decrypt on other device | B |
| FM-09 | Voice messages (Opus + waveform) | Record, send, play on 2nd device, scrub | M |
| FM-10 | Formatted HTML render + matrix.to links | matrix.to opens right room/user in-app; external links ask/open browser only | M |
| FM-11 | Offline/queue behavior | Send while sync broken → queued, retried, no dupes on recovery | M |

### 2.3 Organization & spaces
| ID | Case | Expected | P |
|---|---|---|---|
| FO-01 | 3-pane shell, DM vs room sections | Correct DM detection incl. alias/plural DMs | M |
| FO-02 | Unread badges, notification counts, per-room mute, low-priority | Matches server push rules; mute actually suppresses OS notifications | M |
| FO-03 | Spaces: view/join/nest/read, create + add room | Works across HS-A↔HS-B federated space | M |
| FO-04 | Room upgrade (tombstone) basic | Join upgraded replacement, history link | M |
| FO-05 | Favourites/breadcrumbs | (P1 — skip unless built) | — |

### 2.4 E2EE (make-or-break surface — disproportionate budget per PRD §10.2)
| ID | Case | Expected | P |
|---|---|---|---|
| FE-01 | Default encryption for new DM + private room | Lock shown, keys shared, readable on all own devices | B |
| FE-02 | SAS emoji verification both directions | Emoji match with Element on same account | B |
| FE-03 | QR verification | Cross-verify via scan (desktop↔mobile Element) | B |
| FE-04 | Cross-signing bootstrap | MSSIDs set; Element sees verified status (interop check) | B |
| FE-05 | Key backup + SSSS recovery-key restore | Fresh device → restore → **all prior history decrypts** | B |
| FE-06 | Passphrase-based SSSS restore | Same, incl. wrong-passphrase error path | B |
| FE-07 | Key import/export | Exported megolm keys import into Element decrypt history; vice-versa | M |
| FE-08 | UTD affordance | "unable to decrypt" shows help flow, not dead text; recovery hints correct | M |
| FE-09 | PRD §7 scenario matrix: 2 accounts × 3 devices, recovery, key-rotation, room upgrade | All green before any E2EE claim | B |
| FE-10 | New-device (unverified) in encrypted room | Warning shown; message sharing policy honored (no silent forward to unverified) | B |

### 2.5 Calls & presence (MVP per Decision #6)
| ID | Case | Expected | P |
|---|---|---|---|
| FC-01 | 1:1 native WebRTC voice/video + screen share | Connect, hangup, mic/cam toggles, both directions, ICE via test TURN | M |
| FC-02 | Group call via embedded Element Call | Joins, audio+video round-trips, leave cleans up | M |
| FC-03 | Call in encrypted room | Call events encrypted, no plaintext call metadata leak | B |

### 2.6 Notifications (local-only at MVP per Decision #7)
| ID | Case | Expected | P |
|---|---|---|---|
| FN-01 | OS notification + tray badge + sound | Fires for mentions/DMs on Win + Linux; click focuses right room | M |
| FN-02 | Per-room mute + keywords rules | Suppression verified end-to-end | M |
| FN-03 | Do-not-disturb / focused state | No sound-pop during call or full-screen media | m |

### 2.7 Platform / installers / theming
| ID | Case | Expected | P |
|---|---|---|---|
| FP-01 | Win NSIS silent install, launch, uninstall | No leftover services/profile corruption | B |
| FP-02 | Linux deb + rpm + AppImage on x64; AppImage arm64 | Install/run on clean container | B |
| FP-03 | `--profile` multi-instance | Two instances, separate data dirs | M |
| FP-04 | Theme light/dark/system + accent | Persists across restart | m |
| FP-05 | Keyboard shortcut map + Ctrl+K palette | Documented set all functional | M |
| FP-06 | Accessibility smoke | Tab order sane, screen-reader labels on controls, contrast ≥ WCAG AA on defaults | M |
| FP-07 | Upgrade in place | Old version data + session intact after installing new build over it | B |

### 2.8 Extensibility seam (Decision #10)
| ID | Case | Expected | P |
|---|---|---|---|
| FX-01 | Module registry: first-party features all registered via public seam | Static check: no internal imports across module boundary | M |
| FX-02 | `linnet.config` disable a module | Feature invisible; boot path shrinks (lazy chunks verified in bundle report) | M |

### 2.9 Performance budget (PRD §7 — CI harness, fixed runner, seeded account)
| ID | Gate | Threshold | P |
|---|---|---|---|
| PB-01 | Login→interactive, fresh | ≤ 800 ms | B |
| PB-02 | Login→interactive, 500-room account | ≤ 1.5 s, and ≥2× faster than Element on same fixture (publish receipts) | B |
| PB-03 | RAM steady state, 500 rooms / 10k-event timeline | ≤ 350 MB | B |
| PB-04 | Timeline scroll | 60 fps @ 10k virtualized events (no frame-drop cliff >2%) | M |
| PB-05 | Idle CPU (sync connected) | ≤ 5% | M |
| PB-06 | Initial JS | ≤ 1 MB gz; rest lazy | M |
| PB-07 | Main-thread isolation | Sync + crypto run in worker: long sync never blocks input (measure with 4× CPU throttle) | M |

---

## 3. Security & penetration test cases

Threat model: (T1) malicious/federated **user** in a room (largest surface), (T2) malicious/compromised **homeserver** or MITM, (T3) **local attacker** with the machine/profile dir, (T4) **supply chain** (deps/build), (T5) hosted **web** deployment operator/traffic.

### 3.1 Electron shell hardening (T1/T3)
| ID | Case | Method / Expected | Sev |
|---|---|---|---|
| SH-01 | Config audit | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity` on, `allowRunningInsecureContent` off, no `remote` — assert in code + `elecrack`/electron-linter scan; gate in CI | High if fail |
| SH-02 | window.open / navigation | Message links, `<a target=_blank>`, JS `window.open` from renderer or webview content → only `https:`/`http:`/`matrix:` via `setWindowOpenHandler` → OS browser; anything else (file:, javascript:, custom) denied | Critical if fail |
| SH-03 | IPC validation | Fuzz every `ipcMain` handler with wrong types/paths/protos (e.g. "open this path" as arbitrary absolute); renderer cannot trigger fs/exec beyond contract | Critical if fail |
| SH-04 | Widget/iframe (Element Call embed) | `sandbox` attrs, `allow-popups` escalation denied, postMessage origin checks; attempt parent-frame escape from widget page | High |
| SH-05 | Protocol handler | Register app handler; feed crafted `matrix:`/custom-scheme URI with embedded args — no command exec, no path traversal | Critical |
| SH-06 | ASAR/integrity fuses | RunAsNode disabled in shipped builds; installer Authenticode (Win) + signature verify | High |

### 3.2 Content-injection & XSS (T1 — the classic Matrix client killer)
Every renderer path gets adversarial input from **mallory**:
| ID | Vector | Payload class | Sev |
|---|---|---|---|
| XI-01 | `formatted_body` | HTML5 innerHTML fuzzer suite (script tags, event handlers, SVG/`<animate onload>`, mXSS double-parse via `<listing>`, `<noscript>`, mutation-xss gadgets); verify allowlist sanitizer (DOMPurify-class, allow-list of tags/attrs incl. `data-mx-*` crypto/spoiler attrs only), **client-side, never trust HS-sent HTML** | Critical |
| XI-02 | Room/topic/user **names + avatars** | `<img src=x onerror=...>` in display name, topic, room alias; CSS-inject via mxc:// URL | High |
| XI-03 | Markdown composer round-trip | Payload crafted so raw→rich→edit produces HTML with events; slash-command parsing injection | High |
| XI-04 | Poll answers, reaction keys, thread roots | Same XSS suite through each secondary renderer (poll UI is a forgotten surface) | High |
| XI-05 | Attachment **filenames** | APOW/zip-slip style: `.htm`, `.svg` (executes when opened in browser), bidirectional Unicode, path separators, drive-letter tricks on Win; client must sanitize display *and* save path | Critical |
| XI-06 | SVG images | Inline SVG render attempt (script, `<foreignObject>`, external ref) — must rasterize in isolated context or serve from sandboxed origin | High |
| XI-07 | matrix.to / URL previews | Nested/encoded URI smuggling; (P1 when previews land) SSRF — client-side OG fetch must refuse RFC1918/localhost/metadata IPs | High |
| XI-08 | CSP + deploy posture (web build) — **gate** | Deliver every payload against the hosted build; CSP must be **nonce-only** (no `unsafe-inline`/`unsafe-eval`), **zero third-party scripts**, SRI on all assets, Trusted Types enforced where supported — CSP must block inline/eval even if the sanitizer fails. Audit headers via OWASP ZAP baseline scan (CSP, X-Frame-Options/frame-ancestors, Referrer-Policy, X-Content-Type-Options, HSTS). Must be green for **every hosting mode we publicly ship** (self-host-simple A; hosted-secure B if deployed) | High |

### 3.3 Auth, token & local storage (T2/T3)
| ID | Case | Expected | Sev |
|---|---|---|---|
| AT-01 | Token at rest — web ladder per PRD §8 (A/B/C) | **Desktop:** device token in **OS keychain** (Electron), never localStorage/plain file/sqlite — grep profile dir post-login. **Web self-host-simple (A):** localStorage token tolerated ONLY IF disclosure sentence present ("web build assumes the device/browser is trusted"), nonce-only CSP green (XI-08), short-lived token + idle TTL (AT-06). **Web hosted-secure (B):** SPA JS must not be able to read the access token — verify `HttpOnly; Secure; SameSite=Strict` cookie, refresh rotation works, no `Authorization` header or token visible anywhere in app JS/network on the Balthazar dev deploy | High |
| AT-02 | Log/crash hygiene | Tokens, room ids of secret rooms, keys must never appear in console logs, Sentry payloads, or crash dumps (test: induce crash with `mallory` in room, inspect report before send) | Medium–High |
| AT-03 | TLS posture | HS cert error = hard block, no "proceed anyway" silently; run `testssl.sh` on Balthazar dev deploy → A grade, no mixed content | Medium |
| AT-04 | Multi-account token scoping | Compromise one web storage origin/path can't read another account's token | Medium |
| AT-05 | Per-account origin isolation (hosted web, PRD §8-A) | Two accounts on the hosted build land on separate origins (subdomain per profile); XSS payload planted in acct-1 origin cannot read acct-2 storage, cookies, or network | High |
| AT-06 | Token lifetime + idle TTL (PRD §8-A) | Access token expires per configured policy; idle session auto-logs-out; after logout no live token remains in any storage | Medium |

### 3.4 E2EE protocol attacks (T2 — malicious homeserver is *not* trusted)
| ID | Case | Expected | Sev |
|---|---|---|---|
| EE-01 | Key claim MITM | mitmproxy swaps `alice`'s device/one-time keys on `/keys/query|claim` → cross-signing check **must** surface as verification failure, not silently encrypt to attacker device | Critical |
| EE-02 | Forced downgrade | Proxy strips `m.room.encryption` event or rewrites algorithm; delete+re-add crypto → client keeps encryption state honest, warns on downgrade attempt | Critical |
| EE-03 | Plaintext leak on first messages | Race: send immediately on room create — verify no pre-encryption plaintext window leaks sensitive first utterance (queue until outbound session shared) | High |
| EE-04 | Key backup MITM | Proxy serves foreign backup version/pubkey → client must refuse restore unless SSSS-signed; pollute attempt logged | High |
| EE-05 | Megolm replay/out-of-order | Reorder/duplicate to-device sends + /sync events via proxy → no crash, no double-decrypt, ratchet gaps render as UTD help not garbage | Medium |
| EE-06 | Verification downgrade | Peer offers only SAS when QR possible, unknown `m.key.verification.request` methods → no silent skip; user must be able to see "other device unverified" state truthfully | High |
| EE-07 | Push-rule/notification leak | Local notification content while locked (Win lock screen / Linux lockscreen preview): optional "hide content" mode exists and is discoverable | Low–Med |

### 3.5 Robustness / DoS (T1/T2)
| ID | Case | Expected | Sev |
|---|---|---|---|
| DD-01 | Malformed-event fuzz | Nightly generator: schema-invalid `m.room.member`, `m.reaction`, state events w/ missing fields → no crash, timeline keeps rendering | Medium |
| DD-02 | Media bombs | 50k×50k "image", 500 MB file with lie about size, endless-stream response → bounded memory, cancelable, no renderer OOM kill of app | Medium |
| DD-03 | Timeline flood | Mallory posts 10k events while user mid-scroll → UI stays responsive (virtualization proof), CPU returns to ≤5% idle after | Medium |
| DD-04 | Sync loop torture | Kill HS mid-sync 20× → reconnect with backoff, no token refresh stampede, no dup messages | Medium |

### 3.6 Privacy & telemetry (brand law §8)
| ID | Case | Expected | Sev |
|---|---|---|---|
| PR-01 | Fresh-install capture | Wireharsh/tcpdump first 5 min: **only** configured HS + explicitly opted endpoints. Zero analytics pings. Sentry opt-in gate blocks report uploads until clicked | High if fail |
| PR-02 | Crash report content review | Sample payload contains no message content, no room ids beyond config, no keys | Medium |
| PR-03 | Link click hygiene | External browser opens without `Referer` leak of room names; `rel="noopener noreferrer"` in rendered HTML | Low |

### 3.7 Supply chain (T4)
| ID | Case | Expected | Sev |
|---|---|---|---|
| SC-01 | `pnpm/npm audit` + pnpm.lock in CI, GH Dependabot alerts on; **no Criticals open** at exit; highs need written waiver | — | gate |
| SC-02 | matrix-js-sdk pinned to **stable release** (not develop) — assert exact version in lockfile review | — | gate |
| SC-03 | License scan (ORT/reuse): AGPL-only compat, no AGPL *code* vendored into our MIT/Apache-only... our license IS AGPL so deps just must be compatible — flag copyleft surprises (Element Call license check per PRD §10.4) | — | gate |
| SC-04 | Clean-room guard | PRD §7 zero-copy fuzz importer runs green in CI | gate |
| SC-05 | Release signing | PGP-signed tarballs verify; installers signed; documented verify steps | High |

### 3.8 Tooling list
elecrack / Electron fuses · DOMPurify test corpus + html5-fuzz payloads · mitmproxy hostile-HS script · OWASP ZAP baseline (web build) · testssl.sh · semgrep (JS security rules) · npm audit / pnpm audit · grype on container image for hosted build · sslyze optional.

---

## 4. Exit criteria (the gate)

**Dev stage is EXITED when ALL are true:**

1. **Blockers:** every priority-B functional case PASS or BLOCKED-on-known-server-bug with written owner + retest date. Zero FAIL.
2. **Security:** §3 executed in full. **Zero Critical or High findings open.** Mediums: each has fix-merged or a Sean-approved deferral logged in the gate task. All §3.7 CI gates green.
3. **E2EE credibility (PRD §10.2 rule):** FE-01…FE-10 all green **and** EE-01…EE-06 all green. No "E2EE ready" language anywhere in UI/README until this line passes.
4. **Perf receipts:** PB-01…PB-07 green on the fixed CI runner with artifacts (trace + Element comparison numbers) attached to the release notes, per PRD "claims with receipts" law.
5. **Matrix:** §7 PRD matrix (2 accts × 3 devices × {recovery, rotation, upgrade}) automated in CI, not just manual.
6. **Interop spot-check:** Alice on Linnet ↔ Bob on Element Desktop and Element Web: verify, DM, group, thread, poll, call all work both directions. (We're the new kid; the incumbent is the reference implementation.)
7. **Platform:** FP-01/02/07 pass on every declared target OS/arch.
8. **Privacy:** PR-01 green with packet capture evidence.
9. **Evidence:** gate task contains the results table + linked artifacts for every executed case; failures filed as issues with severity labels. No "assumed pass".
10. **Web posture (PRD §8 ladder):** XI-08 + AT-01/05/06 green for **every hosting mode shipped publicly**; if hosted-secure (B) is deployed at gate time, a test script must demonstrate JS cannot read the token, and the A-posture disclosure sentence must be verifiably present wherever the web build is offered.

**Not exit-blocking (documented known-gaps):** P1/P2 features present-but-broken → tag `p1-bleed`, list in dev notes, no marketing claim for them.

## 5. Suggested execution split
- Automate-in-CI during waves: §3.7, PB-*, XI-01 corpus, DD-01, interop-encrypt matrix.
- Manual/human sessions at gate: verification UX (FE-02/03/05), calls (FC-*), installers (FP-*), adversarial play (mallory on second machine).
- Delegation-ready: §3.1/3.2/3.5 are self-contained BUILDER/RESEARCHER tasks; §3.4 needs the mitmproxy harness first (its own ticket, build in wave 4–5 so it's warm for the gate).

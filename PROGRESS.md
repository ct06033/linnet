# PROGRESS — Linnet wave 1 (scaffold)
Branch task/scaffold. Scaffold only, no protocol features.

## Deliverables
- [x] PROGRESS.md committed first
- [x] 1. pnpm workspace skeleton (root package.json private, engines node>=22, devDeps typescript+prettier; pnpm-workspace.yaml apps/* packages/*)
- [ ] 2. apps/desktop Electron shell (main.ts 1400x900 + single-instance + config via LINNET_CONFIG_DIR; preload.ts contextBridge linnet.config + linnet.modules placeholder typed vs core; electron-builder.yaml win nsis x64 + linux deb/rpm/AppImage, no macOS, output=dist; validate YAML via node, do not run builder)
- [ ] 3. packages/core (matrix-js-sdk newest stable pinned; registry.ts per PRD 6.9 with 6 typed slots, register/enable/disable, flag-gated lazy import + vitest tests; sdk.ts createClientSession MatrixHttpApi+crypto stub + worker TODO; config.ts loader + well-known helper + tests)
- [ ] 4. packages/app Vite+React18 renderer (3-pane mock shell: spaces rail | room list DMs/Rooms+unread pills | timeline placeholder; CSS vars light/dark prefers-color-scheme; account switcher stub; Ctrl+K palette listing registry contributions; vitest smoke)
- [ ] 5. scripts/perf-harness README + bench.mjs printing harness: no baseline yet
- [ ] 6. .github/workflows/ci.yml (install, typecheck, test, build; renderer build real; electron download skipped)
- [ ] 7. README.md dev quickstart
- [ ] 8. SMOKE: pnpm install; pnpm -r typecheck && pnpm -r test && pnpm --filter app build GREEN (failures recorded honestly)

## Log / deviations
- (none yet)

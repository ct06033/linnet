# Linnet

A Matrix client between **Element** and **Cinny** — fast, calm, desktop-first
(**Windows + Linux**), extensible by design.

- Status: MVP (v0.1) build in flight — see kanban board `linnet`
- Spec: [docs/prd.md](docs/prd.md) (locked v0.2)
- Competitive research: [docs/research/element.md](docs/research/element.md) · [docs/research/cinny.md](docs/research/cinny.md)
- License: AGPL-3.0-only

## Development quickstart

Requirements: Node >= 22, pnpm 12.

```sh
pnpm install             # workspace install (set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip the Electron binary)
pnpm -r build            # core -> app renderer -> desktop main/preload bundles
pnpm --filter app dev    # terminal 1: Vite dev server for the renderer (http://localhost:5173)
pnpm --filter desktop dev # terminal 2: bundle main+preload, then launch Electron
```

Layout:

- `apps/desktop` — Electron shell (main + preload + electron-builder config; Win/Linux only, macOS excluded in wave 1)
- `packages/core` — matrix-js-sdk seam, module registry (PRD 6.9), config loader
- `packages/app` — React renderer (3-pane shell, Ctrl+K command palette; all data is mocked until wave 2)
- `scripts/perf-harness` — PRD 7 perf gates (stub until the live-baseline wave)

Config file format: [docs/config.md](docs/config.md). Spec: [docs/prd.md](docs/prd.md).

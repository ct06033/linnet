/**
 * W18 — update orchestrator (Electron MAIN process).
 *
 * Tier 1: GitHub `releases/latest` API check (works for every packaging,
 * unauthenticated; 6-hour cadence) -> broadcasts UpdateState to renderers.
 * Tier 2: where packaging allows (Windows NSIS, Linux AppImage via $APPIMAGE),
 * a user-triggered electron-updater download + quitAndInstall. deb/rpm and
 * dev builds fall back to the release-page link the banner already offers.
 *
 * All state transitions are pushed to every window on channel "linnet:update";
 * the renderer (UpdateBanner) is presentational only.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent } from "electron-updater";
import {
  isNewerVersion,
  latestReleaseApiUrl,
  parseLatestRelease,
  updateCapability,
  type UpdateCapability,
  type UpdateSnapshot,
  type UpdateState,
} from "@linnet/core";

/** Mirror of apps/desktop kv storage (main.ts owns the files). */
export interface UpdaterStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

const KV_ENABLED = "linnet.upda…d";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const BOOT_DELAY_MS = 10_000; // keep the cold start fast
const FETCH_TIMEOUT_MS = 15_000;

let state: UpdateState = { kind: "idle" };
let capability: UpdateCapability = "announce-only";
let enabled = true;
let repo = "ct06033/linnet";
let downloading = false; // one download at a time; guards double-clicks
let seq = 0; // monotonic; renderer drops stale snapshots by this

function currentVersion(): string {
  return app.getVersion();
}

function snapshot(): UpdateSnapshot {
  return { seq, state, current: currentVersion(), capability, enabled };
}

function broadcast(): void {
  const snap = snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("linnet:update", snap);
    } catch {
      /* window mid-close — next one gets it */
    }
  }
}

function setState(next: UpdateState): void {
  state = next;
  seq++;
  broadcast();
}

function releasePageUrl(): string {
  return `https://github.com/${repo}/releases/latest`;
}

/** Tier 1: ask GitHub for the latest release and compare versions. */
async function runCheck(): Promise<UpdateState> {
  setState({ kind: "checking" });
  try {
    const res = await fetch(latestReleaseApiUrl(repo), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Linnet/${currentVersion()}`,
      },
    });
    if (!res.ok) {
      const why = res.status === 403 ? "GitHub rate limit hit (try again later)" : `HTTP ${res.status}`;
      setState({ kind: "error", message: `update check failed: ${why}` });
      return state;
    }
    const rel = parseLatestRelease(await res.json());
    if (!rel) {
      setState({ kind: "error", message: "update check failed: unexpected response" });
      return state;
    }
    if (!isNewerVersion(currentVersion(), rel.version)) {
      setState({ kind: "up-to-date", current: currentVersion() });
      return state;
    }
    setState({
      kind: "available",
      current: currentVersion(),
      version: rel.version,
      url: rel.url || releasePageUrl(),
      notes: rel.notes,
    });
    return state;
  } catch (err) {
    setState({ kind: "error", message: `update check failed: ${String((err as Error)?.message ?? err)}` });
    return state;
  }
}

/**
 * Tier 2: fetch update metadata + download the installer for the current
 * packaging. Only meaningful when packaged AND capability allows; the
 * banner hides the button otherwise, main guards it again anyway.
 */
async function startDownload(): Promise<{ ok: boolean; reason?: string }> {
  if (!app.isPackaged) return { ok: false, reason: "dev build — updates apply to packaged installs only" };
  if (capability !== "install-in-app") return { ok: false, reason: "this package format installs manually" };
  if (downloading) return { ok: false, reason: "already downloading" };
  const avail = state.kind === "available" || state.kind === "ready" ? state.version : null;
  if (!avail) return { ok: false, reason: "no update available — check first" };
  downloading = true;
  setState({ kind: "downloading", version: avail, percent: 0 });
  try {
    autoUpdater.autoDownload = false;
    await autoUpdater.checkForUpdates();
    await autoUpdater.downloadUpdate();
    // completion arrives via the update-downloaded event -> "ready"
    return { ok: true };
  } catch (err) {
    downloading = false;
    setState({ kind: "error", message: `download failed: ${String((err as Error)?.message ?? err)}` });
    return { ok: false, reason: "download failed" };
  }
}

function setEnabled(on: boolean): void {
  enabled = on;
  try {
    store.write(KV_ENABLED, on ? "true" : "false");
  } catch {
    /* persistence failure is non-fatal for the session */
  }
  if (on && app.isPackaged) void runCheck();
}

let store: UpdaterStore = { read: () => null, write: () => undefined };

/**
 * Wire IPC + electron-updater events + the auto-check schedule.
 * Call once from app.whenReady(). `store` is the kv read/write pair from
 * main.ts; `updateRepo` allows forks to point at their own releases.
 */
export function initUpdater(opts: { store: UpdaterStore; repo?: string }): void {
  store = opts.store;
  if (typeof opts.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) {
    repo = opts.repo;
  }
  capability = updateCapability(process.platform, process.env);
  try {
    enabled = store.read(KV_ENABLED) !== "false"; // default ON
  } catch {
    enabled = true;
  }

  // electron-updater events -> state machine (harmless when never used)
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    if (state.kind === "downloading") {
      setState({ kind: "downloading", version: state.version, percent: Math.min(99, Math.round(p.percent)) });
    }
  });
  autoUpdater.on("update-downloaded", (ev: UpdateDownloadedEvent) => {
    downloading = false;
    setState({ kind: "ready", version: String(ev.version ?? (state.kind === "downloading" ? state.version : "")), url: releasePageUrl() });
  });
  autoUpdater.on("error", (err: Error) => {
    // Only surface errors once the user opted into a download; background
    // metadata failures (no app-update.yml on old builds, rate limits) must
    // not fight the Tier-1 GitHub check, which stays authoritative.
    if (downloading) {
      downloading = false;
      setState({ kind: "error", message: `download failed: ${String(err?.message ?? err)}` });
    } else {
      console.warn("linnet updater: electron-updater error (ignored outside download):", err?.message ?? err);
    }
  });

  ipcMain.handle("linnet:update-get", () => snapshot());
  ipcMain.handle("linnet:update-check", () => runCheck());
  ipcMain.handle("linnet:update-download", () => startDownload());
  ipcMain.handle("linnet:update-install", () => {
    if (state.kind !== "ready") return { ok: false, reason: "nothing downloaded yet" };
    setEnabled(false); // stop any re-check racing the restart
    // isSilent=true on NSIS passes /S (the user already consented via the
    // banner); forceRunAfter restarts Linnet when the installer is done.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  });
  ipcMain.handle("linnet:update-set-enabled", (_e, on: boolean) => {
    setEnabled(Boolean(on));
    return snapshot();
  });

  if (app.isPackaged && enabled) {
    setTimeout(() => void runCheck(), BOOT_DELAY_MS);
    setInterval(() => {
      if (enabled) void runCheck();
    }, CHECK_INTERVAL_MS).unref?.();
  }
}

/** Exported for tests / future tray integration. */
export function __updateState(): UpdateSnapshot {
  return snapshot();
}

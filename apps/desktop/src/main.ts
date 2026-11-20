/**
 * Linnet desktop shell (PRD §4). The renderer does everything; main only owns
 * windows, config resolution and OS-backed storage (accounts kv + safeStorage
 * secrets). Notifications/tray land W6.
 */
import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

const DEV_URL = process.env.LINNET_DEV_URL; // e.g. http://localhost:5173

function resolveConfigPath(): string | undefined {
  const candidates = [
    process.env.LINNET_CONFIG_DIR
      ? path.join(process.env.LINNET_CONFIG_DIR, "config.json")
      : undefined,
    path.join(process.resourcesPath ?? "", "config.json"),
    path.join(app.getAppPath(), "config.example.json"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p));
}

function loadConfig(): Record<string, unknown> {
  const p = resolveConfigPath();
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error("linnet: failed to parse config", p, err);
    return {};
  }
}

function rendererDir(): string {
  const packaged = path.join(process.resourcesPath ?? "", "renderer");
  if (fs.existsSync(path.join(packaged, "index.html"))) return packaged;
  return path.resolve(__dirname, "../../..", "packages/app/dist");
}

// ---- storage ports (kv = userData JSON; secrets = safeStorage-encrypted files)
// NOTE: the accounts KV key name must match core ACCOUNTS_KV_KEY.
const safeName = (key: string): string => key.replace(/[^a-zA-Z0-9._-]/g, "_");
// generic KV: one JSON file per key under userData/kv/ — no hardcoded key names
const kvFile = (key: string): string => path.join(app.getPath("userData"), "kv", safeName(key) + ".json");
const secretsDir = (): string => path.join(app.getPath("userData"), "secrets");

function kvRead(key: string): string | null {
  try {
    return fs.readFileSync(kvFile(key), "utf8");
  } catch {
    return null;
  }
}
function kvWrite(key: string, value: string): void {
  fs.mkdirSync(path.dirname(kvFile(key)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(kvFile(key), value, { mode: 0o600 });
}
function kvRemove(key: string): void {
  if (fs.existsSync(kvFile(key))) fs.rmSync(kvFile(key));
}

function secretSave(key: string, value: string): void {
  fs.mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
  const file = path.join(secretsDir(), `${safeName(key)}.bin`);
  let payload: Buffer | string;
  if (safeStorage.isEncryptionAvailable()) {
    payload = safeStorage.encryptString(value);
  } else {
    console.warn("linnet: OS keychain unavailable — token stored UNENCRYPTED (disk-user-only)");
    payload = JSON.stringify({ unencrypted: value });
  }
  fs.writeFileSync(file, payload, { mode: 0o600 });
}
function secretLoad(key: string): string | null {
  const file = path.join(secretsDir(), `${safeName(key)}.bin`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  try {
    const dec = JSON.parse(raw.toString("utf8")) as { unencrypted?: string };
    if (dec.unencrypted) return dec.unencrypted;
  } catch {
    /* not the plaintext envelope -> must be safeStorage ciphertext */
  }
  return safeStorage.decryptString(raw);
}
function secretRemove(key: string): void {
  const file = path.join(secretsDir(), `${safeName(key)}.bin`);
  if (fs.existsSync(file)) fs.rmSync(file);
}

function createWindow(): void {
  // W12a: Linux window/taskbar icon. Packaged runs find it inside the asar
  // (electron-builder.yaml `files` ships build/icon.png; Electron's fs shims
  // read asar paths); dev runs resolve apps/desktop/build/icon.png. The
  // app-grid icon itself comes from the .desktop Icon= key (hicolor set from
  // build/icons/ — see scripts/gen-linux-icons.mjs); this paints the X11
  // _NET_WM_ICON for taskbars/docks that key off the window instead.
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    // W12a: three-pane floor. App CSS (packages/app/src/styles.css) pins the
    // grid to rail 210px + roomlist 300px + timeline 1fr; the timeline's
    // header/composer need ~390px → 900px is the narrowest content width with
    // zero horizontal overflow. Height 560 keeps header + a few timeline rows
    // + typing line + composer visible (roomlist/scroller own their scroll).
    // minWidth/minHeight apply to the WINDOW (content shrinks with the frame);
    // combined with html/body overflow:hidden the page never shows a body
    // scrollbar at any allowed size.
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#101014",
    title: "Linnet",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // W9: matrix.to / image / SSO-provider links always leave the app window
  // for the OS browser — the renderer never gets navigated off Linnet.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(rendererDir(), "index.html"));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.focus();
  });
  ipcMain.handle("linnet:get-config", () => loadConfig());
  ipcMain.handle("linnet:kv:get", (_e, key: string) => kvRead(key));
  ipcMain.handle("linnet:kv:set", (_e, key: string, value: string) => kvWrite(key, value));
  ipcMain.handle("linnet:kv:remove", (_e, key: string) => kvRemove(key));
  ipcMain.handle("linnet:secret:save", (_e, key: string, value: string) => secretSave(key, value));
  ipcMain.handle("linnet:secret:load", (_e, key: string) => secretLoad(key));
  ipcMain.handle("linnet:secret:remove", (_e, key: string) => secretRemove(key));
  // W9: unread badge (Linux docks/Unity; no-op elsewhere) + external opens
  // P1 URL previews: fetch page HTML from the MAIN process (no renderer CORS,
  // no user cookies). https/http only, 8s budget, 400KB cap, html content-type.
  ipcMain.handle("linnet:fetch-url", async (_e, url: string) => {
    try {
      const u = new URL(String(url));
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      const res = await fetch(u.toString(), {
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "LinnetPreview/1.0 (Matrix client; +https://github.com/ct06033/linnet)", Accept: "text/html,*/*" },
      });
      const ctype = res.headers.get("content-type") ?? "";
      const html = res.ok && /text\/html|application\/xhtml|x-html/.test(ctype) ? (await res.text()).slice(0, 400_000) : null;
      return { ok: res.ok, status: res.status, html };
    } catch {
      return null;
    }
  });
  ipcMain.handle("linnet:badge", (_e, count: number) => {
    try {
      app.setBadgeCount(Math.max(0, Math.floor(count)));
    } catch {
      /* Windows has no badge API — harmless */
    }
  });
  ipcMain.on("linnet:open-external", (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  app.whenReady().then(() => {
    // W9: renderer Notification API allowed (system notifications, PRD 6.8);
    // everything else (camera/mic/clipboard…) stays default-deny.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === "notifications");
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}

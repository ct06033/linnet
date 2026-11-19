/**
 * Linnet desktop shell (PRD §4). The renderer does everything; main only owns
 * windows, config resolution and OS-backed storage (accounts kv + safeStorage
 * secrets). Notifications/tray land W6.
 */
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
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
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#101014",
    title: "Linnet",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}

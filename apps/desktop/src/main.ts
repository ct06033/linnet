/**
 * Linnet desktop shell (PRD §4). The renderer does everything; main only owns
 * windows, config resolution and OS integration (notifications/tray come later waves).
 */
import { app, BrowserWindow, ipcMain } from "electron";
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
  // packaged: electron-builder extraResources -> <resources>/renderer
  // dev/worktree: packages/app/dist
  const packaged = path.join(process.resourcesPath ?? "", "renderer");
  if (fs.existsSync(path.join(packaged, "index.html"))) return packaged;
  return path.resolve(__dirname, "../../..", "packages/app/dist");
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
  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}

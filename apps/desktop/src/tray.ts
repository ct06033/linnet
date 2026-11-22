/**
 * W19 3a — system tray glue (main process). The pure decisions live in
 * trayPolicy.ts (unit-tested); this file only wires electron objects:
 * Tray + menu, close-to-tray, session pause (broadcast to renderers), and
 * autostart (Login Items on win32, ~/.config/autostart on linux).
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from "electron";
import fs from "node:fs";
import {
  autostartDesktopFile,
  autostartFilePath,
  onCloseWindow,
  trayMenuLabels,
} from "./trayPolicy.js";

export interface TrayDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  execPath: string;
  iconPath: string;
  /** true while main is shutting down for real (set from before-quit) */
  isQuitting(): boolean;
}

export interface TrayController {
  /** close-event decision: hide window instead of quitting when tray alive */
  handleWindowClose(win: BrowserWindow, e: { preventDefault(): void }): boolean;
  getAutostart(): boolean;
  setAutostart(on: boolean): boolean;
}

let paused = false; // session-only by design (D2)

function broadcastPause(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("linnet:tray-pause", paused);
    } catch {
      /* window closing */
    }
  }
}

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (!win.isVisible()) win.show();
    win.focus();
  }
}

export function initTray(deps: TrayDeps): TrayController | null {
  let tray: Tray | null = null;
  try {
    const img = nativeImage.createFromPath(deps.iconPath);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 22, height: 22 }));
  } catch (err) {
    // Linux without a status-notifier host / exotic setups: degrade to
    // classic window-quit behaviour, never crash the app.
    console.warn("linnet: tray unavailable:", String((err as Error)?.message ?? err));
    return null;
  }

  const rebuildMenu = (): void => {
    const labels = trayMenuLabels(paused);
    const menu = Menu.buildFromTemplate([
      { label: labels.open, click: showMainWindow },
      {
        label: labels.toggle,
        click: () => {
          paused = !paused;
          broadcastPause();
          rebuildMenu();
        },
      },
      { type: "separator" },
      {
        label: labels.quit,
        click: () => {
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(menu);
  };
  rebuildMenu();
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);

  const fileFor = (): string | null => autostartFilePath(deps.platform, deps.homeDir);

  const controller: TrayController = {
    handleWindowClose(win, e) {
      const action = onCloseWindow({ quitting: deps.isQuitting(), trayActive: tray !== null });
      if (action === "hide-to-tray") {
        e.preventDefault();
        win.hide();
        return true;
      }
      return false;
    },
    getAutostart() {
      if (deps.platform === "win32") {
        try {
          return app.getLoginItemSettings().openAtLogin;
        } catch {
          return false;
        }
      }
      const f = fileFor();
      return f ? fs.existsSync(f) : false;
    },
    setAutostart(on) {
      try {
        if (deps.platform === "win32") {
          app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
        } else if (deps.platform === "linux") {
          const f = fileFor();
          if (!f) return false;
          if (on) {
            fs.mkdirSync(f.slice(0, f.lastIndexOf("/")), { recursive: true, mode: 0o755 });
            fs.writeFileSync(f, autostartDesktopFile(deps.execPath), { mode: 0o644 });
          } else if (fs.existsSync(f)) {
            fs.rmSync(f);
          }
        } else {
          return false;
        }
      } catch (err) {
        console.warn("linnet: autostart toggle failed:", String((err as Error)?.message ?? err));
        return controller.getAutostart();
      }
      return on;
    },
  };

  ipcMain.handle("linnet:tray-autostart:get", () => controller.getAutostart());
  ipcMain.handle("linnet:tray-autostart:set", (_e, on: boolean) => controller.setAutostart(Boolean(on)));
  ipcMain.handle("linnet:tray-pause:get", () => paused);

  return controller;
}

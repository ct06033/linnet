/**
 * Trusted bridge only (PRD §4). Typed against @linnet/core; no logic.
 * `linnet.modules` is the placeholder seam the module registry attaches to
 * once renderer-side module loading lands (wave 2+).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { LinnetConfig, UpdateSnapshot, UpdateState } from "@linnet/core";

const bridge = {
  getConfig: (): Promise<Partial<LinnetConfig>> => ipcRenderer.invoke("linnet:get-config"),
  platform: process.platform,
  version: process.env.LINNET_VERSION ?? "0.0.0",
  // W18: update flow — main owns the state machine; renderer only renders it.
  updates: {
    get: (): Promise<UpdateSnapshot> => ipcRenderer.invoke("linnet:update-get"),
    check: (): Promise<UpdateState> => ipcRenderer.invoke("linnet:update-check"),
    download: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("linnet:update-download"),
    install: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke("linnet:update-install"),
    setEnabled: (on: boolean): Promise<UpdateSnapshot> => ipcRenderer.invoke("linnet:update-set-enabled", on),
    onEvent: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: UpdateSnapshot): void => cb(s);
      ipcRenderer.on("linnet:update", listener);
      return () => ipcRenderer.removeListener("linnet:update", listener);
    },
  },
  kv: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke("linnet:kv:get", key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke("linnet:kv:set", key, value),
    remove: (key: string): Promise<void> => ipcRenderer.invoke("linnet:kv:remove", key),
  },
  // W19 3a: tray/background-notify surface (absent = tray unavailable)
  tray: {
    autostartGet: (): Promise<boolean> => ipcRenderer.invoke("linnet:tray-autostart:get"),
    autostartSet: (on: boolean): Promise<boolean> => ipcRenderer.invoke("linnet:tray-autostart:set", on),
    pauseGet: (): Promise<boolean> => ipcRenderer.invoke("linnet:tray-pause:get"),
    onPause: (cb: (paused: boolean) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, paused: boolean): void => cb(paused);
      ipcRenderer.on("linnet:tray-pause", listener);
      return () => ipcRenderer.removeListener("linnet:tray-pause", listener);
    },
  },
  secrets: {
    save: (key: string, value: string): Promise<void> => ipcRenderer.invoke("linnet:secret:save", key, value),
    load: (key: string): Promise<string | null> => ipcRenderer.invoke("linnet:secret:load", key),
    remove: (key: string): Promise<void> => ipcRenderer.invoke("linnet:secret:remove", key),
  },
  // W21 item 8: Windows DWM accent (main polls the registry; null = unavailable)
  systemAccent: {
    get: (): Promise<string | null> => ipcRenderer.invoke("linnet:system-accent:get"),
    onChange: (cb: (hex: string | null) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, hex: string | null): void => cb(hex);
      ipcRenderer.on("linnet:system-accent", listener);
      return () => ipcRenderer.removeListener("linnet:system-accent", listener);
    },
  },
  /** W9: dock/taskbar unread count + open a URL in the OS browser */
  setBadge: (count: number): Promise<void> => ipcRenderer.invoke("linnet:badge", count),
  openExternal: (url: string): void => ipcRenderer.send("linnet:open-external", url),
  fetchUrl: (url: string): Promise<{ ok: boolean; status: number; html: string | null } | null> =>
    ipcRenderer.invoke("linnet:fetch-url", url),
  /** reserved: extension host attach point (docs/prd.md §6.9) */
  modules: {
    async load(_moduleId: string): Promise<{ ok: false; reason: string }> {
      return { ok: false, reason: "plugin host not implemented until P1" };
    },
  },
};

contextBridge.exposeInMainWorld("linnet", bridge);
export type LinnetBridge = typeof bridge;

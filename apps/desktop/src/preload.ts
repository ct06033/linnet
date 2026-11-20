/**
 * Trusted bridge only (PRD §4). Typed against @linnet/core; no logic.
 * `linnet.modules` is the placeholder seam the module registry attaches to
 * once renderer-side module loading lands (wave 2+).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { LinnetConfig } from "@linnet/core";

const bridge = {
  getConfig: (): Promise<Partial<LinnetConfig>> => ipcRenderer.invoke("linnet:get-config"),
  platform: process.platform,
  version: process.env.LINNET_VERSION ?? "0.0.0",
  kv: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke("linnet:kv:get", key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke("linnet:kv:set", key, value),
    remove: (key: string): Promise<void> => ipcRenderer.invoke("linnet:kv:remove", key),
  },
  secrets: {
    save: (key: string, value: string): Promise<void> => ipcRenderer.invoke("linnet:secret:save", key, value),
    load: (key: string): Promise<string | null> => ipcRenderer.invoke("linnet:secret:load", key),
    remove: (key: string): Promise<void> => ipcRenderer.invoke("linnet:secret:remove", key),
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

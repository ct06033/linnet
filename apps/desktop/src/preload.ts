/**
 * Trusted bridge only (PRD §4). Typed against @linnet/core; no logic.
 * `linnet.modules` is the placeholder seam the module registry attaches to
 * once renderer-side module loading lands (wave 2+).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { LinnetConfig } from "@linnet/core";

const bridge = {
  getConfig: (): Promise<Partial<LinnetConfig>> =>
    ipcRenderer.invoke("linnet:get-config"),
  platform: process.platform,
  version: process.env.LINNET_VERSION ?? "0.0.0",
  /** reserved: extension host attach point (docs/prd.md §6.9) */
  modules: {
    async load(_moduleId: string): Promise<{ ok: false; reason: string }> {
      return { ok: false, reason: "plugin host not implemented until P1" };
    },
  },
};

contextBridge.exposeInMainWorld("linnet", bridge);
export type LinnetBridge = typeof bridge;

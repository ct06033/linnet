/** Window bridge injected by apps/desktop preload; web build gets a fallback. */
import type { LinnetConfig } from "@linnet/core";

export interface LinnetWindowBridge {
  getConfig(): Promise<Partial<LinnetConfig>>;
  platform: string;
  version: string;
}

declare global {
  interface Window {
    linnet?: LinnetWindowBridge;
  }
}

export async function readConfig(): Promise<Partial<LinnetConfig>> {
  if (window.linnet) {
    try {
      return await window.linnet.getConfig();
    } catch {
      /* fall through to defaults */
    }
  }
  return {};
}

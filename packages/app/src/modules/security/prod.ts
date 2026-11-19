/**
 * Production SecurityAdapter — thin delegation to the HS-A-proven core e2ee
 * functions; the UI never talks to js-sdk crypto directly.
 */
import type { MatrixClient } from "matrix-js-sdk";
import {
  bootstrapSecurity,
  restoreBackupWithPassphrase,
  restoreBackupWithRecoveryKey,
} from "@linnet/core";
import type { SecurityAdapter } from "./Security.js";
import { probeStatus } from "./state.js";

function tokenOf(client: MatrixClient): string {
  return (client as unknown as { getAccessToken?: () => string | null }).getAccessToken?.() ?? "";
}

export const prodAdapter: SecurityAdapter = {
  async bootstrap(opts) {
    const r = await bootstrapSecurity(opts);
    return r.recoveryKey;
  },
  restorePassphrase: (client, passphrase, onProgress) =>
    restoreBackupWithPassphrase(client, passphrase, onProgress),
  restoreRecoveryKey: (client, key, onProgress) =>
    restoreBackupWithRecoveryKey(client, key, onProgress),
  status: async (client) =>
    probeStatus(
      client as unknown as Parameters<typeof probeStatus>[0],
      tokenOf(client),
    ),
  async runBackup(client) {
    const crypto = client.getCrypto?.();
    await (crypto as unknown as { checkKeyBackupAndEnable?: () => Promise<unknown> } | undefined)?.checkKeyBackupAndEnable?.();
  },
};

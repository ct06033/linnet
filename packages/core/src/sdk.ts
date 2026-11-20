import { createClient, type MatrixClient } from "matrix-js-sdk";
import { getBootstrapKey, getUnlockedSsssKey, pickSsssKeyId } from "./e2ee.js";

/**
 * Thin seam over matrix-js-sdk (pinned stable, never develop — PRD §4).
 * Wave 2 adds fetchFn as THE test seam: matrix-js-sdk 45 honors
 * `fetchFn` in createClient options (verified in lib/client.d.ts,
 * IClientOpts#fetchFn), so SessionManager injects a fake homeserver
 * per-client instead of mutating globalThis.fetch.
 */
export interface SessionOptions {
  homeserverUrl: string;
  accessToken?: string;
  deviceId?: string;
  /** MUST be provided for token-restored clients (login() sets it implicitly;
   *  without it js-sdk treats own-member events as foreign — probed). */
  userId?: string;
  /** Test seam; undefined = js-sdk falls back to global fetch. */
  fetchFn?: typeof globalThis.fetch;
}

export function createClientSession(opts: SessionOptions): MatrixClient {
  if (!/^https?:\/\//.test(opts.homeserverUrl)) {
    throw new Error(`homeserverUrl must be an http(s) URL, got: ${opts.homeserverUrl}`);
  }
  // 4S bootstrap stores cross-signing secrets into a brand-new key in the same
  // call; the getSecretStorageKey callback (fixed at createClient time) finds
  // that key via the per-client holder in e2ee.ts. W14 adds the SECOND source:
  // the user-unlocked key parked by the unlock-session flow
  // (setUnlockedSsssKey) — without it, accounts that already have Secure
  // Secret Storage crashed at "getSecretStorageKey callback returned falsey"
  // when bootstrapCrossSigning imported from 4S. Single-SSSS-key product
  // assumption: match the advertised key id (default key preferred; re-key
  // flows land later).
  let self: MatrixClient;
  // js-sdk 45 reads clientOpts.threadSupport in the CONSTRUCTOR (client.js:652
  // + getter ~7099) but declares the field only on IStartClientOpts — a typing
  // gap; spread dodges the excess-property check without using `any`.
  const client = createClient({
    ...({ threadSupport: true } as { threadSupport: boolean }),
    baseUrl: opts.homeserverUrl,
    accessToken: opts.accessToken,
    deviceId: opts.deviceId,
    userId: opts.userId,
    fetchFn: opts.fetchFn,
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }: { keys: Record<string, unknown> }, _name: string) => {
        const privateKey = self ? getBootstrapKey(self) ?? getUnlockedSsssKey(self) : undefined;
        const keyId = self ? pickSsssKeyId(self, keys) : undefined;
        return privateKey && keyId ? [keyId, privateKey] : null;
      },
    },
  });
  self = client;
  return client;
}

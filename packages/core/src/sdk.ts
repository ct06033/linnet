import { createClient, type MatrixClient } from "matrix-js-sdk";

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
  return createClient({
    baseUrl: opts.homeserverUrl,
    accessToken: opts.accessToken,
    deviceId: opts.deviceId,
    userId: opts.userId,
    fetchFn: opts.fetchFn,
  });
}

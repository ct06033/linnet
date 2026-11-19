import { createClient, type MatrixClient } from "matrix-js-sdk";

/**
 * Thin seam over matrix-js-sdk (pinned stable, never develop — PRD §4).
 * Wave 2 wires this into a dedicated worker thread; wave 3 adds crypto init.
 * Everything above this file must remain SDK-swap friendly (Cinny lesson).
 */
export interface SessionOptions {
  homeserverUrl: string;
  accessToken?: string;
  deviceId?: string;
}

export function createClientSession(opts: SessionOptions): MatrixClient {
  if (!/^https?:\/\//.test(opts.homeserverUrl)) {
    throw new Error(`homeserverUrl must be an http(s) URL, got: ${opts.homeserverUrl}`);
  }
  return createClient({
    baseUrl: opts.homeserverUrl,
    accessToken: opts.accessToken,
    deviceId: opts.deviceId,
  });
}

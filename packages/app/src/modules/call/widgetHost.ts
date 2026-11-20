/**
 * W15 phase 2a — minimal HOST-side widget driver for the embedded Element
 * Call iframe. Implements the App-Widgets v1.x envelope matrix-widget-api
 * speaks: {api:"w", sender, widgetId, jsonrpc:"2.0", method, params, id}
 * plus the legacy {action:"widget_api_request"} handshake, relaying
 * send/sendState through the real js-sdk client so the iframe's call
 * membership (m.call.member) lands in the room.
 *
 * SCOPE HONESTY: this satisfies the handshake + event-relay contract and is
 * unit-tested against that contract. Full capability negotiation
 * (receiveState backfill, TURN delegation, delayed-leave) is phase 2b, which
 * also needs the public call.nervweb.com origin (DirectNic CNAME + LE cert)
 * before a live iframe can load at all.
 */
import type { MatrixClient } from "matrix-js-sdk";

export interface WidgetHostOptions {
  client: MatrixClient;
  roomId: string;
  widgetId: string;
  iframe: HTMLIFrameElement;
  origin: string;
}

interface WireMessage {
  api?: string;
  sender?: string;
  widgetId?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  jsonrpc?: string;
  action?: string;
  requestId?: string;
  data?: { supported?: string[] };
}

export function startWidgetHost(opts: WidgetHostOptions): { stop: () => void } {
  const send = (msg: Record<string, unknown>): void => {
    try {
      opts.iframe.contentWindow?.postMessage(msg, opts.origin);
    } catch {
      /* iframe gone */
    }
  };
  const base = { api: "w", sender: "host", widgetId: opts.widgetId };

  const onMessage = (ev: MessageEvent): void => {
    const m = ev.data as WireMessage | null;
    if (!m || typeof m !== "object" || m.api !== "w" || m.sender !== "widget") return;
    if (m.widgetId && m.widgetId !== opts.widgetId) return;

    // Legacy version handshake: widget (or host) asks which api versions exist.
    if (m.action === "widget_api_request") {
      send({ ...base, action: "widget_api_response", requestId: m.requestId, supported: ["toWidget", "toHost", "mobile.android"] });
      return;
    }

    // JSON-RPC driver calls (v1.x)
    if (m.jsonrpc === "2.0" && typeof m.method === "string") {
      void handleRpc(m).catch((err: unknown) =>
        send({ ...base, jsonrpc: "2.0", id: m.id, error: { code: -32000, message: String((err as Error)?.message ?? err) } }),
      );
    }
  };

  const handleRpc = async (m: WireMessage): Promise<void> => {
    const p = (m.params ?? {}) as Record<string, unknown>;
    switch (m.method) {
      case "sendEvent": {
        const type = p["type"] as string | undefined;
        const content = (p["content"] ?? {}) as Record<string, unknown>;
        const r = await (opts.client.sendEvent as unknown as (roomId: string, type: string, content: object) => Promise<{ event_id: string }>)(
          opts.roomId, String(type), content,
        );
        send({ ...base, jsonrpc: "2.0", id: m.id, result: { event_id: r.event_id } });
        return;
      }
      case "sendStateEvent": {
        const type = p["type"] as string | undefined;
        const key = (p["state_key"] ?? "") as string;
        const content = (p["content"] ?? {}) as Record<string, unknown>;
        const r = await (opts.client.sendStateEvent as unknown as (roomId: string, type: string, content: object, key: string) => Promise<{ event_id: string }>)(
          opts.roomId, String(type), content, String(key),
        );
        send({ ...base, jsonrpc: "2.0", id: m.id, result: { event_id: r.event_id } });
        return;
      }
      case "supportedApi": {
        send({ ...base, jsonrpc: "2.0", id: m.id, result: { api: ["toWidget", "toHost", "sendEvent", "sendStateEvent"] } });
        return;
      }
      default:
        send({ ...base, jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  };

  window.addEventListener("message", onMessage);
  // Kick the legacy handshake the way Element hosts do (idempotent if the
  // widget started first).
  const hs = { ...base, action: "widget_api_request", requestId: `linnet-${Date.now()}`, data: { supported: ["action.capabilities"] } };
  send(hs);
  return { stop: () => window.removeEventListener("message", onMessage) };
}

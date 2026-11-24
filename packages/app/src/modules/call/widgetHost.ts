/**
 * W15 phase 2b — HOST-side widget driver for the embedded Element Call
 * iframe, against the real matrix-widget-api v1.x stable wire contract
 * (verified 2026-11-20 against the shipped Element Call v0.28.2 bundle AND
 * the real matrix-widget-api 1.20 PostmessageTransport, live against Synapse:
 * envelope {api:"fromWidget"|"toWidget", widgetId, requestId, action, data},
 * responses echo requestId+action with respond:true. MSC2974 negotiation.)
 *
 * Handled from-widget actions:
 *   supported_api_versions        → our advertised version list (see SCOPE)
 *   capabilities / msc2974        → grant (trusted own-widget model, as Element hosts)
 *   content_loaded                → ack
 *   send_event (state_key?, delay?)→ js-sdk sendEvent/sendStateEvent in our room
 *   send_to_device                → js-sdk sendToDevice
 *   get_openid                    → OpenID token minted via the HS /loginToken
 *                                   endpoint → EC then POSTs same-origin /get_token
 *                                   to lk-jwt itself (verified live 2026-11-20)
 *   msc4515 get_rtc_transports    → {rtc_transports} from /rtc/transports
 * Pushes to-widget:
 *   capabilities (post-grant notification)
 *   update_state (MSC2762)        → m.call.member backfill on start + every
 *                                   live room-state change, so the widget
 *                                   sees who else joined/left the call
 *
 * SCOPE (honest, and deliberate): we do NOT advertise org.matrix.msc4533,
 * so Element Call uses the legacy OpenID flow for LiveKit tokens and its own
 * delay_* body fields for delayed leave — the path our Balthazar infra was
 * verified against (same-origin /get_token → lk-jwt FULL_ACCESS). MSC4533
 * host delegation (rtc_livekit_get_token / delegate_delayed_leave) would be a
 * later hardening, not needed for a working call. TURN (msc3846) is not
 * advertised: LiveKit SFUs relay media themselves, no TURN creds are involved.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { RoomStateEvent } from "matrix-js-sdk";

export interface WidgetHostOptions {
  client: MatrixClient;
  roomId: string;
  widgetId: string;
  iframe: HTMLIFrameElement;
  origin: string;
  /** W21 item 10: fired on ANY genuine widget-side message — proof the
   *  Element Call page loaded and its transport is alive. The stage uses it
   *  to disarm its unreachable-service watchdog (no more silent blank frame). */
  onActivity?: () => void;
}

/** What we advertise in supported_api_versions. msc4533/3846 intentionally absent — see SCOPE. */
export const HOST_API_VERSIONS = [
  "0.0.1",
  "0.0.2",
  "org.matrix.msc2762",
  "org.matrix.msc2762_update_state",
  "org.matrix.msc2974",
  "org.matrix.msc4515",
];

/** Capabilities we're willing to grant to our own trusted call widget. */
const GRANTABLE = new Set([
  "m.always_on_screen",
  "m.sticker",
  "org.matrix.msc2877.send_state",
  "org.matrix.msc2876.read_events",
  "org.matrix.msc4157.send.delayed_event",
  "org.matrix.msc4407.send.sticky_event",
  "org.matrix.msc4407.receive.sticky_event",
]);

export const CALL_MEMBER_EVENT = "m.call.member";

interface WireMessage {
  api?: string;
  widgetId?: string;
  requestId?: string;
  action?: string;
  data?: Record<string, unknown>;
}

export function startWidgetHost(opts: WidgetHostOptions): { stop: () => void } {
  const send = (msg: Record<string, unknown>): void => {
    try {
      opts.iframe.contentWindow?.postMessage(msg, opts.origin);
    } catch {
      /* iframe gone */
    }
  };
  let reqSeq = 0;
  /** Host→widget push (toWidget direction, per PostmessageTransport wire shape). */
  const pushToWidget = (action: string, data: Record<string, unknown>): void => {
    send({ api: "toWidget", widgetId: opts.widgetId, requestId: `linnet-${++reqSeq}`, action, data });
  };
  /** Response = the request echoed back verbatim plus a `response` payload
   *  (PostmessageTransport.handleMessage branches on ev.data.response). */
  const respond = (m: WireMessage, data: Record<string, unknown>): void => {
    send({ ...m, response: data });
  };
  const fail = (m: WireMessage, message: string): void => {
    send({
      ...m,
      response: { error: { code: "org.matrix.widgets.UnknownAction", message, details: {} } },
    });
  };

  const onMessage = (ev: MessageEvent): void => {
    const m = ev.data as WireMessage | null;
    if (!m || typeof m !== "object" || typeof m.action !== "string") return;
    if (m.api === "toWidget") return; // our own pushes echoed back by the widget as responses
    if (!m.api || m.api === "widget_api") {
      // Legacy handshake (pre-fromWidget envelope): both sides use it at start.
      if (m.action === "widget_api_request") {
        send({ ...m, response: { supported: ["toWidget", "toHost", "mobile.android"] } });
      }
      return;
    }
    if (m.api !== "fromWidget") return;
    if (m.widgetId !== opts.widgetId) return;
    opts.onActivity?.();

    const d = (m.data ?? {}) as Record<string, unknown>;
    switch (m.action) {
      case "supported_api_versions":
        respond(m, { versions: HOST_API_VERSIONS });
        return;

      case "capabilities":
      case "org.matrix.msc2974.request_capabilities": {
        const list = Array.isArray(d["capabilities"]) ? (d["capabilities"] as unknown[]) : [];
        const given = list.filter((c): c is string => typeof c === "string" && isGrantable(c));
        for (const c of given) granted.add(c);
        const union = [...granted];
        respond(m, { updated: union });
        // Once the widget has negotiated, hand it the current call membership.
        backfillCallMembers();
        return;
      }

      case "content_loaded":
        respond(m, {});
        return;

      case "send_event": {
        const type = String(d["type"] ?? "");
        const content = (d["content"] ?? {}) as Record<string, unknown>;
        const roomId = typeof d["room_id"] === "string" ? d["room_id"] : opts.roomId;
        if (roomId !== opts.roomId) {
          fail(m, "widget may only write its own room");
          return;
        }
        void (typeof d["state_key"] === "string"
          ? (opts.client.sendStateEvent as unknown as (roomId: string, type: string, content: object, key: string) => Promise<{ event_id: string }>)(
              roomId, type, content, d["state_key"],
            )
          : (opts.client.sendEvent as unknown as (roomId: string, type: string, content: object) => Promise<{ event_id: string }>)(
              roomId, type, content,
            )
        )
          .then((r) => respond(m, { room_id: roomId, event_id: r.event_id }))
          .catch((err: unknown) => fail(m, String((err as Error)?.message ?? err)));
        return;
      }

      case "send_to_device": {
        const type = String(d["type"] ?? "");
        const messages = (d["messages"] ?? {}) as Record<string, Record<string, unknown>>;
        void (opts.client.sendToDevice as unknown as (type: string, msgs: Record<string, Record<string, unknown>>, append?: boolean) => Promise<unknown>)(
          type, messages, Boolean(d["ephemeral"]),
        )
          .then(() => respond(m, {}))
          .catch((err: unknown) => fail(m, String((err as Error)?.message ?? err)));
        return;
      }

      case "get_openid": {
        void (opts.client as unknown as {
          getOpenIdToken: () => Promise<{ access_token: string; expires_in: number; matrix_server_name: string; token_type: string }>;
        })
          .getOpenIdToken()
          .then((t) =>
            respond(m, {
              state: "allowed",
              access_token: t.access_token,
              token_type: t.token_type ?? "Bearer",
              expires_in: t.expires_in,
              matrix_server_name: t.matrix_server_name,
            }),
          )
          .catch((err: unknown) => fail(m, String((err as Error)?.message ?? err)));
        return;
      }

      case "org.matrix.msc4515.get_rtc_transports": {
        void (async () => {
          const http = (opts.client as unknown as {
            http: { authedRequest<T>(method: string, path: string, qs?: object, data?: object, opts?: { prefix?: string }): Promise<T> };
          }).http;
          type Body = { transports?: unknown[]; rtc_transports?: unknown[] };
          let data: Body | null = null;
          for (const [prefix, path] of [
            ["/_matrix/client/v1", "/rtc/transports"],
            ["/_matrix/client/unstable", "/org.matrix.msc4143/rtc/transports"],
          ] as Array<[string, string]>) {
            try {
              data = await http.authedRequest<Body>("GET", path, undefined, undefined, { prefix });
              if (data) break;
            } catch {
              data = null;
            }
          }
          respond(m, { rtc_transports: data?.transports ?? data?.rtc_transports ?? [] });
        })().catch((err: unknown) => fail(m, String((err as Error)?.message ?? err)));
        return;
      }

      default:
        fail(m, `unsupported action: ${m.action}`);
    }
  };

  const pushState = (type: string, stateKey: string, content: unknown): void => {
    pushToWidget("update_state", { type, state_key: stateKey, content, room_id: opts.roomId });
  };

  const granted = new Set<string>();
  // Static grants + the MSC2762 event/state_event/message/to_device patterns
  // Element Call requests for its membership traffic (granted per the same
  // trusted-own-widget model Element Web uses).
  const isGrantable = (c: string): boolean =>
    GRANTABLE.has(c) ||
    /^org\.matrix\.msc2762\.(send|receive)\.(state_event|event|message|to_device_message)(:.*)?$/.test(c) ||
    /^org\.matrix\.msc2877\./.test(c);

  const stateEventContent = (ev: { getContent: () => unknown; getStateKey?: () => string }): { content: unknown; key: string } => ({
    content: ev.getContent(),
    key: typeof ev.getStateKey === "function" ? ev.getStateKey() : "",
  });

  const backfillCallMembers = (): void => {
    const room = opts.client.getRoom(opts.roomId);
    const evs = (room?.currentState?.getStateEvents?.(CALL_MEMBER_EVENT) ?? []) as unknown as Array<{
      getContent: () => unknown;
      getStateKey?: () => string;
    }>;
    for (const ev of evs) {
      const { content, key } = stateEventContent(ev);
      pushState(CALL_MEMBER_EVENT, key, content);
    }
  };

  // Live m.call.member changes → update_state pushes (remote joins/leaves).
  const onRoomState = (event: unknown, state?: { roomId?: string }): void => {
    if (state && state.roomId && state.roomId !== opts.roomId) return;
    const ev = event as { getType?: () => string; getContent: () => unknown; getStateKey?: () => string };
    try {
      if (ev.getType?.() === CALL_MEMBER_EVENT) {
        const { content, key } = stateEventContent(ev);
        pushState(CALL_MEMBER_EVENT, key, content);
      }
    } catch {
      /* malformed event — ignore */
    }
  };
  opts.client.on(RoomStateEvent.Events, onRoomState as never);

  window.addEventListener("message", onMessage);
  // Kick the legacy handshake the way Element hosts do (idempotent if the
  // widget started first).
  const hs = { api: "widget_api", action: "widget_api_request", requestId: `linnet-${Date.now()}`, data: { supported: ["action.capabilities"] } };
  send(hs);
  return {
    stop: () => {
      window.removeEventListener("message", onMessage);
      try {
        opts.client.off(RoomStateEvent.Events, onRoomState as never);
      } catch {
        /* client gone */
      }
    },
  };
}

/**
 * W15 phase 2a — group calls: MatrixRTC transport discovery + the m.call
 * widget lifecycle (PRD §6.7 group calls / W14 item 15 phase 2).
 *
 * Shape of the world (verified 2026-11-20 against Balthazar + HS-A):
 *  - Synapse 1.165 serves GET /_matrix/client/v1/rtc/transports (final MSC4143;
 *    unstable org.matrix.msc4143 fallback kept for older servers) returning
 *    transports: [{type:"livekit", livekit_service_url:"https://call.nervweb.com"}].
 *  - Element Call v0.28.2 then runs the legacy openID flow: POST
 *    {livekit_service_url}/get_token on the SAME origin as the app (no CORS —
 *    swag call-nervweb-com vhost proxies /get_token|/sfu/get|/healthz to
 *    lk-jwt-service 0.7.0, whose FULL_ACCESS list contains our server_name).
 *  - Widget discovery in the room is spec'd via m.widget state events; the
 *    conference id is "<roomId>$<componentId>" (Element convention).
 *
 * NOTE (honesty, per Sean's policy): the widget-URL query params follow the
 * Element Web CallWidget convention; the live handshake with a loaded
 * call.nervweb.com iframe is phase 2b — it cannot run until the DirectNic
 * CNAME + LE cert from the Part-1 infra land.
 */
import type { MatrixClient } from "matrix-js-sdk";

export interface LivekitTransport {
  livekit_service_url: string;
}

interface RawTransport {
  type?: string;
  livekit_service_url?: string;
}

/** GET /v1/rtc/transports, unstable fallback; [] when the HS has none. */
export async function fetchLivekitTransports(client: MatrixClient): Promise<LivekitTransport[]> {
  // js-sdk 45: request() is gone — the sanctioned path is http.authedRequest
  // (adds the Bearer token itself), exactly like Element Call's own bundle.
  const http = (client as unknown as {
    http: {
      authedRequest<T>(method: string, path: string, qs?: object, data?: object, opts?: { prefix?: string }): Promise<T>;
    };
  }).http;
  const attempts: Array<[string, string]> = [
    ["/_matrix/client/v1", "/rtc/transports"],
    ["/_matrix/client/unstable", "/org.matrix.msc4143/rtc/transports"],
  ];
  type TransportsBody = { transports?: RawTransport[]; rtc_transports?: RawTransport[] };
  let data: TransportsBody | null = null;
  for (const [prefix, path] of attempts) {
    try {
      data = await http.authedRequest<TransportsBody>("GET", path, undefined, undefined, { prefix });
      if (data) break;
    } catch {
      data = null;
    }
  }
  const list = data?.transports ?? data?.rtc_transports ?? [];
  return list
    .filter((t: RawTransport) => t?.type === "livekit" && typeof t.livekit_service_url === "string")
    .map((t: RawTransport) => ({ livekit_service_url: t.livekit_service_url as string }));
}

export const WIDGET_EVENT_TYPE = "m.widget";
export const WIDGET_COMPONENT_ID = "linnet.call";

export function widgetIdFor(roomId: string): string {
  return `${roomId}$${WIDGET_COMPONENT_ID}`;
}

/** Element convention: conferenceId = the widget id ("<roomId>$<component>"). */
export function conferenceIdFor(roomId: string): string {
  return widgetIdFor(roomId);
}

export function callWidgetUrl(serviceUrl: string, roomId: string): string {
  const base = serviceUrl.endsWith("/") ? serviceUrl.slice(0, -1) : serviceUrl;
  const widgetId = widgetIdFor(roomId);
  const q = new URLSearchParams({
    conferenceId: conferenceIdFor(roomId),
    roomId,
    widgetId,
  });
  return `${base}/?${q.toString()}`;
}

export interface CallWidgetContent {
  id: string;
  creatorUserId: string;
  name: string;
  type: string;
  url: string;
  data: Record<string, unknown>;
}

export function buildCallWidgetContent(userId: string, roomId: string, serviceUrl: string): CallWidgetContent {
  return {
    id: widgetIdFor(roomId),
    creatorUserId: userId,
    name: "Group call",
    type: "call",
    url: callWidgetUrl(serviceUrl, roomId),
    data: {},
  };
}

export interface ActiveCallWidget extends CallWidgetContent {
  serviceUrl: string;
}

/** What we last PUT for a room (js-sdk keeps chronological pendings out of
 *  reach; a local cache gives deterministic reuse + tombstone visibility). */
const widgetCache = new WeakMap<MatrixClient, Map<string, CallWidgetContent | null>>();

/** True when a non-empty m.call widget exists (remote echo OR our own last write). */
export function existingWidget(client: MatrixClient, roomId: string): CallWidgetContent | null {
  const room = client.getRoom(roomId);
  const widgetId = widgetIdFor(roomId);
  const ev = room?.currentState?.getStateEvents?.(WIDGET_EVENT_TYPE, widgetId);
  const remote = (ev as unknown as { getContent?: () => CallWidgetContent } | undefined)?.getContent?.();
  if (remote && remote.type === "call" && remote.url) return remote;
  const cached = widgetCache.get(client)?.get(roomId);
  return cached && cached.type === "call" && cached.url ? cached : null;
}

/** Discover transport + create (or reuse) the m.call widget. Readable errors. */
export async function ensureCallWidget(client: MatrixClient, roomId: string): Promise<ActiveCallWidget> {
  const transports = await fetchLivekitTransports(client);
  if (transports.length === 0)
    throw new Error("this homeserver has no MatrixRTC transport configured — group calls unavailable");
  const serviceUrl = transports[0]!.livekit_service_url;
  const me = client.getUserId();
  if (!me) throw new Error("not logged in");
  const found = existingWidget(client, roomId);
  if (found && found.creatorUserId === me) return { ...found, serviceUrl };
  const content = buildCallWidgetContent(me, roomId, serviceUrl);
  // m.widget is not in js-sdk 45's EventType enum (W5b lesson) — untyped call.
  await (client.sendStateEvent as unknown as (roomId: string, type: string, content: object, key: string) => Promise<{ event_id: string }>)(
    roomId,
    WIDGET_EVENT_TYPE,
    content,
    content.id,
  );
  rememberWidget(client, roomId, content);
  return { ...content, serviceUrl };
}

function rememberWidget(client: MatrixClient, roomId: string, content: CallWidgetContent | null): void {
  let map = widgetCache.get(client);
  if (!map) {
    map = new Map();
    widgetCache.set(client, map);
  }
  map.set(roomId, content);
}

/** Leave = tombstone the widget (spec: empty content on the same state key). */
export async function removeCallWidget(client: MatrixClient, roomId: string): Promise<void> {
  const widgetId = widgetIdFor(roomId);
  if (!existingWidget(client, roomId)) return;
  await (client.sendStateEvent as unknown as (roomId: string, type: string, content: object, key: string) => Promise<unknown>)(
    roomId,
    WIDGET_EVENT_TYPE,
    {},
    widgetId,
  );
  rememberWidget(client, roomId, null);
}

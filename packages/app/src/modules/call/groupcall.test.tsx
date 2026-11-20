/**
 * W15 phase 2a — group-call slice: MSC4143 transport discovery against the
 * fake HS (seedable /rtc/transports), m.call widget content/lifecycle, the
 * host-side widget driver relay (App-Widgets envelope contract), and the
 * GroupCallStage iframe embed incl. Leave tombstoning the widget.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent } from "matrix-js-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createClientSession,
  createFakeHomeserver,
  makeSyncSnapshot,
  type FakeHomeserverControls,
} from "@linnet/core";
import {
  buildCallWidgetContent,
  callWidgetUrl,
  conferenceIdFor,
  ensureCallWidget,
  existingWidget,
  fetchLivekitTransports,
  removeCallWidget,
  widgetIdFor,
} from "./groupcall.js";
import { startWidgetHost } from "./widgetHost.js";
import { GroupCallStage } from "./GroupCallStage.js";

const SERVICE = "https://call.nervweb.com";
const ROOM = "!group:hs.test";
const ALICE = { userId: "@alice:hs.test", password: "pa", accessToken: "tok-a" };

// ── pure builders ───────────────────────────────────────────────────────────
describe("groupcall pure helpers", () => {
  it("widget id follows <roomId>$<component> and conference id mirrors it", () => {
    expect(widgetIdFor(ROOM)).toBe(`${ROOM}$linnet.call`);
    expect(conferenceIdFor(ROOM)).toBe(widgetIdFor(ROOM));
  });
  it("widget URL carries conferenceId/roomId/widgetId on the transport origin", () => {
    const url = callWidgetUrl(`${SERVICE}/`, ROOM);
    expect(url.startsWith(`${SERVICE}/?`)).toBe(true);
    const q = new URLSearchParams(url.split("?")[1] ?? "");
    expect(q.get("conferenceId")).toBe(widgetIdFor(ROOM));
    expect(q.get("roomId")).toBe(ROOM);
    expect(q.get("widgetId")).toBe(widgetIdFor(ROOM));
  });
  it("m.call widget content matches the Element CallWidget shape", () => {
    const c = buildCallWidgetContent(ALICE.userId, ROOM, SERVICE);
    expect(c).toMatchObject({
      id: widgetIdFor(ROOM),
      creatorUserId: ALICE.userId,
      type: "call",
      name: "Group call",
    });
    expect(c.url).toContain(SERVICE);
  });
});

// ── fake-HS integration ─────────────────────────────────────────────────────
describe("transport discovery + widget lifecycle over fake HS", () => {
  let fetchFn: ReturnType<typeof createFakeHomeserver>;
  let ctl: FakeHomeserverControls;
  let alice: MatrixClient;

  beforeAll(async () => {
    fetchFn = createFakeHomeserver({
      accounts: [ALICE],
      rtcTransports: [{ type: "livekit", livekit_service_url: SERVICE }],
      sync: (userId) =>
        makeSyncSnapshot({
          userId,
          rooms: [{ roomId: ROOM, name: "group", members: { [ALICE.userId]: "join", "@b:hs.test": "join" } }],
        }),
    });
    ctl = fetchFn.controls;
    alice = createClientSession({
      homeserverUrl: "https://hs.test",
      accessToken: ALICE.accessToken,
      deviceId: "DA",
      userId: ALICE.userId,
      fetchFn,
    });
    await new Promise<void>((res, rej) => {
      const on = (s: string): void => {
        if (s === "PREPARED" || s === "SYNCING") res();
        if (s === "ERROR") rej(new Error("sync error"));
      };
      alice.on(ClientEvent.Sync, on as never);
      alice.startClient({ initialSyncLimit: 25 });
    });
  });

  it("fetchLivekitTransports reads the livekit entry", async () => {
    const ts = await fetchLivekitTransports(alice);
    expect(ts).toEqual([{ livekit_service_url: SERVICE }]);
  });

  it("ensureCallWidget PUTs m.widget keyed by widget id", async () => {
    const w = await ensureCallWidget(alice, ROOM);
    expect(w.url).toContain("conferenceId=");
    const put = ctl.calls.find((c) => c.method === "PUT" && c.path.includes("/state/m.widget/"));
    expect(put).toBeTruthy();
    expect(put!.path).toContain(encodeURIComponent(widgetIdFor(ROOM)));
    // local echo: existingWidget sees it with our content
    expect(existingWidget(alice, ROOM)?.type).toBe("call");
    // second call reuses (no second PUT)
    const before = ctl.calls.filter((c) => c.method === "PUT" && c.path.includes("/state/m.widget/")).length;
    await ensureCallWidget(alice, ROOM);
    const after = ctl.calls.filter((c) => c.method === "PUT" && c.path.includes("/state/m.widget/")).length;
    expect(after).toBe(before);
  });

  it("removeCallWidget tombstones with empty content", async () => {
    await removeCallWidget(alice, ROOM);
    const puts = ctl.calls.filter((c) => c.method === "PUT" && c.path.includes("/state/m.widget/"));
    const last = puts[puts.length - 1]!;
    expect(last.body).toEqual({});
    // tombstone arrives via the sync echo — async by construction
    await waitFor(() => expect(existingWidget(alice, ROOM)).toBeNull());
  });

  it("missing transport surfaces a readable error", async () => {
    const bare = createFakeHomeserver({ accounts: [ALICE], sync: (u) => makeSyncSnapshot({ userId: u, rooms: [] }) });
    const c = createClientSession({ homeserverUrl: "https://hs.test", accessToken: ALICE.accessToken, deviceId: "D", userId: ALICE.userId, fetchFn: bare });
    await expect(fetchLivekitTransports(c)).resolves.toEqual([]);
    await expect(ensureCallWidget(c, ROOM)).rejects.toThrow(/MatrixRTC transport/);
  });
});

// ── host widget driver (App-Widgets envelope contract) ─────────────────────
describe("widgetHost driver", () => {
  const widgetId = widgetIdFor(ROOM);

  function fakeIframe(): { el: HTMLIFrameElement; posted: Record<string, unknown>[] } {
    const posted: Record<string, unknown>[] = [];
    const el = {
      contentWindow: {
        postMessage: (msg: Record<string, unknown>) => posted.push(msg),
      },
    } as unknown as HTMLIFrameElement;
    return { el, posted };
  }

  function fakeClient(): { client: MatrixClient; sent: unknown[]; states: unknown[] } {
    const sent: unknown[] = [];
    const states: unknown[] = [];
    const client = {
      sendEvent: async (r: string, t: string, c: unknown) => {
        sent.push([r, t, c]);
        return { event_id: "$ev1" };
      },
      sendStateEvent: async (r: string, t: string, c: unknown, k: string) => {
        states.push([r, t, c, k]);
        return { event_id: "$st1" };
      },
    } as unknown as MatrixClient;
    return { client, sent, states };
  }

  function widgetMsg(data: Record<string, unknown>): MessageEvent {
    return new MessageEvent("message", {
      data: { api: "w", sender: "widget", widgetId, ...data },
      origin: SERVICE,
    });
  }

  it("answers the version handshake and posts widget_api_request on start", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    const host = startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    expect(posted.some((p) => p.action === "widget_api_request")).toBe(true);
    window.dispatchEvent(widgetMsg({ action: "widget_api_response", requestId: "x", data: { supported: [] } }));
    host.stop();
  });

  it("relays sendStateEvent (m.call.member) and echoes the jsonrpc id", () => {
    const { el, posted } = fakeIframe();
    const { client, states } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    window.dispatchEvent(
      widgetMsg({
        jsonrpc: "2.0",
        id: "42",
        method: "sendStateEvent",
        params: { type: "m.call.member", state_key: "", content: { membership: { "dummy": {} } } },
      }),
    );
    return waitFor(() => {
      expect(states).toHaveLength(1);
      expect((states[0] as [string, string])[1]).toBe("m.call.member");
      const ack = posted.find((p) => p.id === "42");
      expect(ack).toBeTruthy();
      expect((ack as { result: { event_id: string } }).result.event_id).toBe("$st1");
      expect(ack!.sender).toBe("host");
    });
  });

  it("rejects unknown methods and ignores foreign widget ids", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    window.dispatchEvent(widgetMsg({ jsonrpc: "2.0", id: "9", method: "teleport", params: {} }));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { api: "w", sender: "widget", widgetId: "!other$evil", jsonrpc: "2.0", id: "10", method: "sendEvent", params: {} },
        origin: SERVICE,
      }),
    );
    return waitFor(() => {
      const err = posted.find((p) => p.id === "9");
      expect((err as { error: { code: number } }).error.code).toBe(-32601);
      expect(posted.find((p) => p.id === "10")).toBeUndefined();
    });
  });

  it("ignores non-envelope messages", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    const n = posted.length;
    window.dispatchEvent(new MessageEvent("message", { data: { hello: "world" }, origin: "https://evil.test" }));
    expect(posted.length).toBe(n);
  });
});

// ── GroupCallStage component ────────────────────────────────────────────────
describe("GroupCallStage", () => {
  let fetchFn: ReturnType<typeof createFakeHomeserver>;
  let alice: MatrixClient;

  beforeAll(async () => {
    fetchFn = createFakeHomeserver({
      accounts: [ALICE],
      rtcTransports: [{ type: "livekit", livekit_service_url: SERVICE }],
      sync: (userId) =>
        makeSyncSnapshot({
          userId,
          rooms: [{ roomId: ROOM, name: "group", members: { [ALICE.userId]: "join", "@b:hs.test": "join" } }],
        }),
    });
    alice = createClientSession({
      homeserverUrl: "https://hs.test",
      accessToken: ALICE.accessToken,
      deviceId: "DA",
      userId: ALICE.userId,
      fetchFn,
    });
    await new Promise<void>((res, rej) => {
      const on = (s: string): void => {
        if (s === "PREPARED" || s === "SYNCING") res();
        if (s === "ERROR") rej(new Error("sync error"));
      };
      alice.on(ClientEvent.Sync, on as never);
      alice.startClient({ initialSyncLimit: 25 });
    });
  });

  it("renders the Element Call iframe once the widget exists, then leaves", async () => {
    const onClose = vi.fn();
    render(<GroupCallStage client={alice} roomId={ROOM} onClose={onClose} />);
    const frame = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe.ec-frame");
      expect(f).toBeTruthy();
      return f!;
    });
    expect(frame.src).toContain("call.nervweb.com");
    expect(frame.src).toContain("conferenceId=");
    expect(frame.getAttribute("allow")).toContain("display-capture");
    expect(frame.title).toBe("Element Call");
    fireEvent.click(screen.getByRole("button", { name: /leave group call/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the readable error when the homeserver has no transport", async () => {
    const bare = createFakeHomeserver({
      accounts: [ALICE],
      sync: (u) => makeSyncSnapshot({ userId: u, rooms: [{ roomId: ROOM, name: "g", members: { [ALICE.userId]: "join" } }] }),
    });
    const client = createClientSession({
      homeserverUrl: "https://hs.test",
      accessToken: ALICE.accessToken,
      deviceId: "DX",
      userId: ALICE.userId,
      fetchFn: bare,
    });
    await act(async () => {
      render(<GroupCallStage client={client} roomId={ROOM} onClose={() => undefined} />);
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/MatrixRTC transport/));
  });
});

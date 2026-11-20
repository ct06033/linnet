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

// ── host widget driver v2 (real matrix-widget-api PostmessageTransport shape:
//    {api:"fromWidget", widgetId, requestId, action, data} / respond:true) ───
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

  function fakeMemberEvent(sender: string, key: string, content: unknown) {
    return {
      getType: () => "m.call.member",
      getStateKey: () => key,
      getSender: () => sender,
      getContent: () => content,
    };
  }

  function fakeClient(opts: { members?: unknown[] } = {}): {
    client: MatrixClient;
    sent: unknown[];
    states: unknown[];
    devices: unknown[];
    stateHandlers: Array<(ev: unknown, st?: { roomId?: string }) => void>;
  } {
    const sent: unknown[] = [];
    const states: unknown[] = [];
    const devices: unknown[] = [];
    const stateHandlers: Array<(ev: unknown, st?: { roomId?: string }) => void> = [];
    const client = {
      sendEvent: async (r: string, t: string, c: unknown) => {
        sent.push([r, t, c]);
        return { event_id: "$ev1" };
      },
      sendStateEvent: async (r: string, t: string, c: unknown, k: string) => {
        states.push([r, t, c, k]);
        return { event_id: "$st1" };
      },
      sendToDevice: async (t: string, m: unknown) => {
        devices.push([t, m]);
        return {};
      },
      getOpenIdToken: async () => ({
        access_token: "openid-alice-fake",
        token_type: "Bearer",
        expires_in: 3600000,
        matrix_server_name: "hs.test",
      }),
      getRoom: () => ({
        currentState: {
          getStateEvents: (type: string) => (type === "m.call.member" ? (opts.members ?? []) : []),
        },
      }),
      on: (_ev: string, fn: (e: unknown, st?: { roomId?: string }) => void) => {
        stateHandlers.push(fn);
      },
      off: (_ev: string, fn: (e: unknown) => void) => {
        const i = stateHandlers.indexOf(fn as never);
        if (i >= 0) stateHandlers.splice(i, 1);
      },
      http: {
        authedRequest: async () => ({ transports: [{ type: "livekit", livekit_service_url: SERVICE }] }),
      },
    } as unknown as MatrixClient;
    return { client, sent, states, devices, stateHandlers };
  }

  let reqSeq = 0;
  function widgetMsg(action: string, data: Record<string, unknown> = {}, fromWidget = true): MessageEvent {
    return new MessageEvent("message", {
      data: { api: fromWidget ? "fromWidget" : "widget_api", widgetId, requestId: `wreq-${++reqSeq}`, action, data },
      origin: SERVICE,
    });
  }
  function replyFor(posted: Record<string, unknown>[], requestId: string): Record<string, unknown> | undefined {
    return posted.find((p) => p.requestId === requestId);
  }
  function ask(el: { posted: Record<string, unknown>[] }, action: string, data: Record<string, unknown>): MessageEvent {
    const msg = widgetMsg(action, data);
    const requestId = ((msg.data as Record<string, unknown>).requestId as string);
    (el as unknown as { ids?: string[] }).ids?.push(requestId);
    lastReqId = requestId;
    window.dispatchEvent(msg);
    return msg;
  }
  let lastReqId = "";

  it("answers the version handshake and posts widget_api_request on start", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    const host = startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    expect(posted.some((p) => p.action === "widget_api_request")).toBe(true);
    window.dispatchEvent(widgetMsg("widget_api_response", {}, false));
    host.stop();
  });

  it("supported_api_versions: advertises 2762/2974/4515, NOT msc4533/msc3846", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "supported_api_versions", {});
    const ack = replyFor(posted, lastReqId) as { response: { versions: string[] }; };
    expect(ack.response).toBeTruthy();
    expect(ack.response.versions).toContain("org.matrix.msc2762");
    expect(ack.response.versions).toContain("org.matrix.msc2974");
    expect(ack.response.versions).toContain("org.matrix.msc4515");
    expect(ack.response.versions).not.toContain("org.matrix.msc4533");
    expect(ack.response.versions).not.toContain("town.robin.msc3846");
  });

  it("MSC2974 grants static + msc2762 patterns, rejects TURN, notifies, backfills m.call.member", () => {
    const members = [fakeMemberEvent("@bob:hs.test", "mem1", { "m.call.member": { member_id: "mem1" } })];
    const { el, posted } = fakeIframe();
    const { client } = fakeClient({ members });
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "org.matrix.msc2974.request_capabilities", {
      capabilities: ["m.always_on_screen", "town.robin.msc3846.turn_servers", "org.matrix.msc2762.send.state_event:m.call.member#*"],
    });
    const ack = replyFor(posted, lastReqId) as { response: { updated: string[] } };
    expect(ack.response.updated).toContain("m.always_on_screen");
    expect(ack.response.updated).toContain("org.matrix.msc2762.send.state_event:m.call.member#*");
    expect(ack.response.updated).not.toContain("town.robin.msc3846.turn_servers");
    expect(posted.filter((p) => p.action === "notify_capabilities").length).toBe(0);
    const bs = posted.find((p) => p.action === "update_state" && (p.data as { type: string }).type === "m.call.member");
    expect(bs).toBeTruthy();
    expect(((bs as { data: { content: Record<string, unknown> } }).data.content["m.call.member"] as { member_id: string }).member_id).toBe("mem1");
  });

  it("relays send_event state writes (m.call.member join) and echoes the requestId", () => {
    const { el, posted } = fakeIframe();
    const { client, states } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "send_event", { type: "m.call.member", state_key: "mem-xyz", content: { "m.call.member": { member_id: "mem-xyz" } }, room_id: ROOM });
    return waitFor(() => {
      expect(states).toHaveLength(1);
      expect((states[0] as [string, string])[1]).toBe("m.call.member");
      const ack = replyFor(posted, lastReqId) as { response: { event_id: string; room_id: string }; };
      expect(ack.response).toBeTruthy();
      expect(ack.response.event_id).toBe("$st1");
      expect(ack.response.room_id).toBe(ROOM);
    });
  });

  it("relays send_event state-less messages to sendEvent", () => {
    const { el, posted } = fakeIframe();
    const { client, sent } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "send_event", { type: "m.reaction", content: { "m.relates_to": {} }, room_id: ROOM });
    return waitFor(() => {
      expect(sent).toHaveLength(1);
      expect((sent[0] as [string, string])[1]).toBe("m.reaction");
    });
  });

  it("refuses send_event into a foreign room", () => {
    const { el, posted } = fakeIframe();
    const { client, states } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "send_event", { type: "m.room.topic", state_key: "", content: {}, room_id: "!other:hs.test" });
    return waitFor(() => {
      expect(states).toHaveLength(0);
      const err = replyFor(posted, lastReqId) as { response: { error: { message: string } } };
      expect(err.response.error.message).toMatch(/own room/);
    });
  });

  it("get_openid returns an allowed OpenID credential bundle", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "get_openid", {});
    return waitFor(() => {
      const ack = replyFor(posted, lastReqId) as { response: Record<string, string> };
      expect(ack.response.state).toBe("allowed");
      expect(ack.response.access_token).toBe("openid-alice-fake");
      expect(ack.response.matrix_server_name).toBe("hs.test");
    });
  });

  it("msc4515 get_rtc_transports returns the livekit transport list", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "org.matrix.msc4515.get_rtc_transports", {});
    return waitFor(() => {
      const ack = replyFor(posted, lastReqId) as { response: { rtc_transports: Array<{ livekit_service_url: string }> } };
      expect(ack.response.rtc_transports[0]!.livekit_service_url).toBe(SERVICE);
    });
  });

  it("pushes update_state on live m.call.member changes (remote leave tombstone)", () => {
    const { el, posted } = fakeIframe();
    const { client, stateHandlers } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    expect(stateHandlers).toHaveLength(1);
    stateHandlers[0]!(fakeMemberEvent("@bob:hs.test", "mem1", {}), { roomId: ROOM });
    const push = posted.find((p) => p.action === "update_state") as { data: { content: unknown; state_key: string } };
    expect(push.data.state_key).toBe("mem1");
    expect(push.data.content).toEqual({});
  });

  it("relays send_to_device", () => {
    const { el, posted } = fakeIframe();
    const { client, devices } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "send_to_device", { type: "m.call.notify", messages: { "@b:hs.test": { D: {} } } });
    return waitFor(() => {
      expect(devices).toHaveLength(1);
      expect(replyFor(posted, lastReqId)).toBeTruthy();
    });
  });

  it("rejects unknown actions and ignores foreign widget ids", () => {
    const { el, posted } = fakeIframe();
    const { client } = fakeClient();
    startWidgetHost({ client, roomId: ROOM, widgetId, iframe: el, origin: SERVICE });
    ask({ posted }, "teleport", {});
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { api: "fromWidget", widgetId: "!other$evil", requestId: "x10", action: "send_event", data: {} },
        origin: SERVICE,
      }),
    );
    return waitFor(() => {
      const err = replyFor(posted, lastReqId) as { response: { error: { message: string } } };
      expect(err.response.error.message).toMatch(/teleport/);
      expect(posted.find((p) => p.requestId === "x10")).toBeUndefined();
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

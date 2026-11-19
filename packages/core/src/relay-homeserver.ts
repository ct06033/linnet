/**
 * In-memory RELAY homeserver — wave-3a E2EE integration test seam.
 * Unlike fake-homeserver.ts (single-user, static sync), the relay keeps
 * MUTABLE SHARED state so multiple in-process matrix-js-sdk clients with
 * real rust crypto can complete a full Megolm handshake + round-trip:
 * login/sync queues, room state, /send append, /sendToDevice fan-out,
 * /keys upload|query|claim (OTKs popped once), /keys/changes.
 * Test-only; never ship.
 */

export interface RelayAccount {
  userId: string;
  password: string;
  accessToken: string;
  deviceId: string;
}

export interface RelayRoomSpec {
  roomId: string;
  name?: string;
  members: string[];
  encrypted?: boolean;
}

export interface RelayConfig {
  accounts: RelayAccount[];
  rooms?: RelayRoomSpec[];
}

export interface RelayEvent {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  event_id: string;
  origin_server_ts: number;
  depth: number;
  prev_events: unknown[];
  auth_events: unknown[];
  unsigned: Record<string, unknown>;
  room_id?: string;
  state_key?: string;
}

export interface RelayStats {
  keyUploads: number;
  otkUploaded: number;
  otkClaimed: number;
  toDeviceSent: number;
}

export interface RelayHomeserver {
  /** fetch with "Authorization: Bearer <token>" injected when absent. */
  fetchFnFor(token: string): typeof globalThis.fetch;
  /** raw handler (token comes from request headers). */
  fetchFn: typeof globalThis.fetch;
  rawTimeline(roomId: string): RelayEvent[];
  stats(): RelayStats;
  /** devices of userId that uploaded identity/device keys. */
  deviceKeyCount(userId: string): number;
}

interface DeviceKeys {
  keys?: Record<string, unknown>;
  otpks: Map<string, unknown>;
  fallbacks: Map<string, unknown>;
}

interface UserSyncState {
  initialDone: boolean;
  pending: { roomId: string; ev: RelayEvent }[];
  toDevice: RelayEvent[];
}

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bearer(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (Array.isArray(h)) return String(h.find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "");
  if (typeof Headers !== "undefined" && h instanceof Headers) return h.get("authorization");
  const rec = h as Record<string, string>;
  return rec["Authorization"] ?? rec["authorization"] ?? null;
}

async function bodyJson(init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const p: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createRelayHomeserver(config: RelayConfig): RelayHomeserver {
  const byToken = new Map(config.accounts.map((a) => [a.accessToken, a]));
  const rooms = config.rooms ?? [];
  const timeline = new Map<string, RelayEvent[]>(rooms.map((r) => [r.roomId, []]));
  const keys = new Map<string, DeviceKeys>(); // `${userId}|${deviceId}`
  const syncState = new Map<string, UserSyncState>(
    config.accounts.map((a) => [a.userId, { initialDone: false, pending: [], toDevice: [] }]),
  );
  const stats: RelayStats = { keyUploads: 0, otkUploaded: 0, otkClaimed: 0, toDeviceSent: 0 };
  let evSeq = 0;
  let seq = 0;
  const nextBatch = () => `s${++seq}`;

  // FIXTURE REQUIREMENTS: state_key when state, origin_server_ts, depth, prev/auth_events.
  const ev = (
    roomId: string,
    type: string,
    sender: string,
    content: Record<string, unknown>,
    stateKey?: string,
  ): RelayEvent => ({
    type,
    sender,
    content,
    room_id: roomId,
    event_id: `$e${++evSeq}`,
    origin_server_ts: Date.now(),
    depth: ++evSeq,
    prev_events: [],
    auth_events: [],
    unsigned: {},
    ...(stateKey !== undefined ? { state_key: stateKey } : {}),
  });

  const stateFor = (room: RelayRoomSpec): RelayEvent[] => {
    const events = [
      ev(room.roomId, "m.room.create", room.members[0]!, { creator: room.members[0], room_version: "11" }, ""),
      ev(
        room.roomId,
        "m.room.power_levels",
        room.members[0]!,
        { users_default: 100, state_default: 0, events_default: 0, notifications: { room: 100 } },
        "",
      ),
    ];
    if (room.name !== undefined) events.push(ev(room.roomId, "m.room.name", room.members[0]!, { name: room.name }, ""));
    if (room.encrypted) events.push(ev(room.roomId, "m.room.encryption", room.members[0]!, { algorithm: "m.megolm.v1.aes-sha2" }, ""));
    for (const m of room.members) events.push(ev(room.roomId, "m.room.member", m, { membership: "join" }, m));
    return events;
  };

  const otkCountFor = (userId: string): number => {
    let n = 0;
    for (const [k, d] of keys) if (k.startsWith(`${userId}|`)) n += d.otpks.size;
    return n;
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const segs = path.split("/").map(decodeURIComponent);
    const token = (bearer(init) ?? "").replace(/^Bearer /, "");
    const account = byToken.get(token);

    if (segs.at(-1) === "versions") return jsonRes({ versions: ["v1.11", "v1.2"], unstable_features: {} });
    if (segs.at(-1) === "capabilities") return jsonRes({ capabilities: {} });
    if (segs.at(-1) === "login" && method === "POST") {
      const body = await bodyJson(init);
      const who = (body.identifier as { user?: string } | undefined)?.user ?? (body.user as string | undefined);
      const hit = config.accounts.find((a) => a.userId === who && a.password === body.password);
      if (!hit) return jsonRes({ errcode: "M_FORBIDDEN", error: "bad credentials" }, 403);
      return jsonRes({ access_token: hit.accessToken, device_id: hit.deviceId, user_id: hit.userId });
    }
    if (segs.at(-1) === "logout") return jsonRes({});
    if (segs.at(-1) === "whoami") {
      return account
        ? jsonRes({ user_id: account.userId, is_guest: false })
        : jsonRes({ errcode: "M_UNKNOWN_TOKEN" }, 401);
    }
    if (segs.at(-1) === "filter") return jsonRes({ filter_id: "relay" });

    if (segs.at(-1) === "sync") {
      if (!account) return jsonRes({ errcode: "M_UNKNOWN_TOKEN" }, 401);
      const st = syncState.get(account.userId)!;
      const counts = { "signed_curve25519": otkCountFor(account.userId) };
      if (!st.initialDone || !url.searchParams.get("since")) {
        const join: Record<string, unknown> = {};
        for (const r of rooms) {
          if (!r.members.includes(account.userId)) continue;
          join[r.roomId] = {
            state: { events: stateFor(r) },
            timeline: { events: [], limited: false, prev_batch: "b0" },
          };
        }
        st.initialDone = true;
        // spec: initial sync reports device_lists.changed for every user you share
        // a room with — crypto silently skips key-sharing without it (relay bug found
        // by the e2ee round-trip test, 2026-11-18)
        const changed = [...new Set(rooms.filter((r) => r.members.includes(account.userId)).flatMap((r) => r.members))].filter((u) => u !== account.userId);
        return jsonRes({
          next_batch: nextBatch(),
          rooms: { join, invite: {}, leave: {} },
          presence: { events: [] },
          account_data: { events: [] },
          to_device: { events: [] },
          device_lists: { changed, left: [] },
          device_one_time_keys_count: counts,
        });
      }
      // incremental: drain this user's queues
      if (st.pending.length === 0 && st.toDevice.length === 0) {
        await new Promise((r) => setTimeout(r, 15)); // mild backpressure vs hot-spin
      }
      const byRoom: Record<string, unknown> = {};
      for (const { roomId, ev: e } of st.pending.splice(0)) {
        const bucket = (byRoom[roomId] ??= { timeline: { events: [], limited: false, prev_batch: "b0" } }) as {
          timeline: { events: RelayEvent[] };
        };
        bucket.timeline.events.push(e);
      }
      const toDevice = st.toDevice.splice(0);
      return jsonRes({
        next_batch: nextBatch(),
        rooms: { join: byRoom },
        to_device: { events: toDevice },
        device_lists: { changed: [], left: [] },
        device_one_time_keys_count: counts,
      });
    }

    // ---- everything below requires auth ----
    if (!account) return jsonRes({ errcode: "M_UNKNOWN_TOKEN" }, 401);
    const body = method === "GET" ? {} : await bodyJson(init);

    const ri = segs.lastIndexOf("rooms");
    if (ri >= 0 && segs[ri + 2] === "send") {
      // /rooms/{roomId}/send/{type}/{txn}
      const roomId = segs[ri + 1]!;
      const type = segs[ri + 3]!;
      const e = ev(roomId, type, account.userId, (body ?? {}) as Record<string, unknown>);
      let log = timeline.get(roomId);
      if (!log) timeline.set(roomId, (log = []));
      log.push(e);
      for (const m of rooms.find((r) => r.roomId === roomId)?.members ?? []) {
        syncState.get(m)?.pending.push({ roomId, ev: e });
      }
      return jsonRes({ event_id: e.event_id });
    }

    const di = segs.lastIndexOf("sendToDevice");
    if (di >= 0 && method === "PUT") {
      // /sendToDevice/{type}/{txn} — respect recipient user→device map, deliver as-is
      const type = String(segs[di + 1]);
      const messages = (body.messages ?? {}) as Record<string, Record<string, unknown>>;
      for (const [userId, devices] of Object.entries(messages)) {
        for (const payload of Object.values(devices)) {
          syncState.get(userId)?.toDevice.push(
            ev("$", type, account.userId, (payload ?? {}) as Record<string, unknown>),
          );
          stats.toDeviceSent++;
        }
      }
      return jsonRes({});
    }

    if (segs.at(-2) === "keys" && segs.at(-1) === "upload" && method === "POST") {
      const devId = String((body.device_keys as Record<string, unknown> | undefined)?.device_id ?? account.deviceId);
      const keySlotId = `${account.userId}|${devId}`;
      let slot = keys.get(keySlotId);
      if (!slot) keys.set(keySlotId, (slot = { otpks: new Map(), fallbacks: new Map() }));
      if (body.device_keys) slot.keys = body.device_keys as Record<string, unknown>;
      for (const [id, k] of Object.entries((body.one_time_keys ?? {}) as Record<string, unknown>)) {
        slot.otpks.set(id, k);
        stats.otkUploaded++;
      }
      for (const [id, k] of Object.entries((body.fallback_keys ?? {}) as Record<string, unknown>)) {
        slot.fallbacks.set(id, k);
      }
      stats.keyUploads++;
      return jsonRes({ "one_time_key_counts": { signed_curve25519: slot.otpks.size } });
    }

    if (segs.at(-2) === "keys" && segs.at(-1) === "query" && method === "POST") {
      const req = (body.device_keys ?? {}) as Record<string, string[]>;
      const out: Record<string, Record<string, unknown>> = {};
      for (const userId of Object.keys(req)) {
        const wanted = req[userId] ?? [];
        const devices: Record<string, unknown> = {};
        for (const [k, d] of keys) {
          if (!k.startsWith(`${userId}|`) || !d.keys) continue;
          const devId = k.slice(userId.length + 1);
          if (wanted.length === 0 || wanted.includes(devId)) devices[devId] = d.keys;
        }
        out[userId] = devices;
      }
      return jsonRes({ device_keys: out });
    }

    if (segs.at(-2) === "keys" && segs.at(-1) === "claim" && method === "POST") {
      const req = (body.one_time_keys ?? {}) as Record<string, Record<string, string>>;
      const claimed: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [userId, devices] of Object.entries(req)) {
        for (const [devId, algorithm] of Object.entries(devices)) {
          const slot = keys.get(`${userId}|${devId}`);
          if (!slot || slot.otpks.size === 0) continue;
          const id = [...slot.otpks.keys()].find((k) => k.startsWith(algorithm)) ?? slot.otpks.keys().next().value!;
          const key = slot.otpks.get(id)!;
          slot.otpks.delete(id); // popped — never re-issued
          ((claimed[userId] ??= {})[devId] ??= {})[id] = key;
          stats.otkClaimed++;
        }
      }
      return jsonRes({ one_time_keys: claimed });
    }

    if (segs.at(-2) === "keys" && segs.at(-1) === "changes") return jsonRes({ changed: [], left: [] });

    return jsonRes({});
  };

  const fetchFn = handler as unknown as typeof globalThis.fetch;
  return {
    fetchFn,
    fetchFnFor: (token: string) =>
      ((input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = new Headers(init.headers ?? {});
        if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
        return fetchFn(input, { ...init, headers });
      }) as typeof globalThis.fetch,
    rawTimeline: (roomId) => [...(timeline.get(roomId) ?? [])],
    stats: () => ({ ...stats }),
    deviceKeyCount: (userId) =>
      [...keys.entries()].filter(([k, d]) => k.startsWith(`${userId}|`) && d.keys).length,
  };
}

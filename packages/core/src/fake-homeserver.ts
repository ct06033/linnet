/**
 * Fake Matrix homeserver as a fetch replacement — TESTS ONLY (exported from
 * the package so @linnet/app reuses the same seam; never use in prod).
 *
 * Wave 4 adds real conversation mechanics: /send with echo + multi-account
 * fanout, /redact, /messages back-pagination, receipts, typing (outgoing
 * record + ctl.pushTyping ephemera), join/invite, state get/put, media upload,
 * deterministic failure injection, a recorded call log, and a LONG-POLL sync
 * that resolves the moment ctl.push delivers an event.
 */

export interface FakeAccount {
  userId: string;
  password: string;
  accessToken: string;
  deviceId?: string;
}

export interface FakeEventLike {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  room_id?: string;
  event_id?: string;
  origin_server_ts?: number;
  state_key?: string;
  unsigned?: Record<string, unknown>;
  depth?: number;
  prev_events?: string[];
  auth_events?: string[];
}

export interface FakeRoom {
  roomId: string;
  name: string;
  topic?: string;
  /** seed m.room.encryption state event (drives E2EE badge / UTD paths) */
  encrypted?: boolean;
  /** extra members besides the snapshot user: userId -> membership */
  members?: Record<string, string>;
  /** newest-last seed timeline */
  events?: FakeEventLike[];
  /** older history returned by /messages back-pagination */
  old?: FakeEventLike[];
}

export interface FakeInvite {
  roomId: string;
  name: string;
  inviter?: string;
}

export interface FakeCallRecord {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeHomeserverOptions {
  accounts: FakeAccount[];
  /** First /sync body per user id; defaults to an empty snapshot. */
  sync?: (userId: string) => unknown;
  /** Per-user room feed for /messages back-pagination (the `old` arrays). */
  roomsLookup?(userId: string): Array<{ roomId: string; old?: FakeEventLike[] }>;
}

export interface FakeHomeserverControls {
  calls: FakeCallRecord[];
  /** Deliver an event to a user's next (or parked) sync. */
  push(userId: string, roomId: string, ev: FakeEventLike): void;
  /** Deliver ephemeral typing state to a user. */
  pushTyping(userId: string, roomId: string, members: string[]): void;
  /** Next /send returns this error once (then clears). */
  failNextSend(status: number, errcode?: string): void;
  /** Reset recorded call log. */
  resetCalls(): void;
  nextEventId(): string;
}

type FetchWithControls = typeof globalThis.fetch & { controls: FakeHomeserverControls };

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (_name: string) => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bearer(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  let value: string | null = null;
  if (Array.isArray(h)) {
    const hit = h.find(([k]) => k.toLowerCase() === "authorization");
    value = hit ? String(hit[1]) : null;
  } else if (typeof Headers !== "undefined" && h instanceof Headers) {
    value = h.get("authorization");
  } else {
    const rec = h as Record<string, string>;
    value = rec["Authorization"] ?? rec["authorization"] ?? null;
  }
  return value && value.startsWith("Bearer ") ? value.slice(7) : value;
}

async function bodyJson(init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function makeSyncSnapshot(opts: {
  userId: string;
  rooms?: FakeRoom[];
  invites?: FakeInvite[];
  /** Room ids listed under m.direct for opts.userId (drives the isDM heuristic). */
  direct?: string[];
  nextBatch?: string;
}): unknown {
  const ev = (
    roomId: string,
    type: string,
    content: unknown,
    extra?: Record<string, unknown>,
  ) => ({
    type,
    sender: opts.userId,
    content,
    room_id: roomId,
    event_id: `$${type.replace(/[^a-z.]/gi, "")}-${roomId}`,
    origin_server_ts: 1,
    depth: 1,
    prev_events: [],
    auth_events: [],
    unsigned: {},
    ...extra,
  });
  // state_key makes them real state events; power_levels satisfies js-sdk auth rules (learned the hard way)
  const stateEvents = (roomId: string, r: FakeRoom) => {
    const out: Record<string, unknown>[] = [
      ev(roomId, "m.room.create", { creator: opts.userId, room_version: "11" }, { state_key: "" }),
      ev(roomId, "m.room.power_levels", { users_default: 100, state_default: 0, events_default: 0, notifications: { room: 100 } }, { state_key: "" }),
      ev(roomId, "m.room.name", { name: r.name }, { state_key: "" }),
      ev(roomId, "m.room.member", { membership: "join" }, { state_key: opts.userId }),
    ];
    if (r.topic) {
      out.push(ev(roomId, "m.room.topic", { topic: r.topic }, { state_key: "" }));
    }
    if (r.encrypted) {
      out.push(ev(roomId, "m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }, { state_key: "" }));
    }
    for (const [uid, membership] of Object.entries(r.members ?? {})) {
      out.push(ev(roomId, "m.room.member", { membership }, { state_key: uid, sender: uid }));
    }
    return out;
  };
  const join: Record<string, unknown> = {};
  for (const r of opts.rooms ?? []) {
    join[r.roomId] = {
      state: { events: stateEvents(r.roomId, r) },
      timeline: {
        events: (r.events ?? []).map((e, i) => ({
          depth: i + 1,
          prev_events: [],
          auth_events: [],
          unsigned: {},
          event_id: e.event_id ?? `$seed-${r.roomId}-${i}`,
          origin_server_ts: e.origin_server_ts ?? 1000 + i,
          room_id: r.roomId,
          ...e,
        })),
        limited: false,
        prev_batch: "b0",
      },
    };
  }
  const invite: Record<string, unknown> = {};
  for (const r of opts.invites ?? []) {
    const inviter = r.inviter ?? "@someone:hs.test";
    // js-sdk 45 reads invites from invite_state:{events} (NOT invite_room_state) — probed
    invite[r.roomId] = {
      invite_state: {
        events: [
          ev(r.roomId, "m.room.create", { creator: inviter, room_version: "11" }, { state_key: "", sender: inviter }),
          ev(r.roomId, "m.room.name", { name: r.name }, { state_key: "", sender: inviter }),
          ev(r.roomId, "m.room.member", { membership: "invite" }, { state_key: opts.userId, sender: inviter }),
        ],
      },
    };
  }
  return {
    next_batch: opts.nextBatch ?? "b2",
    rooms: { join, invite },
    account_data: {
      events: opts.direct
        ? [ev("$root", "m.direct", { [opts.userId]: opts.direct })]
        : [],
    },
    presence: { events: [] },
    to_device: { events: [] },
    device_lists: { changed: {}, left: {} },
    device_one_time_keys_count: {},
  };
}

interface QueueItem {
  roomId: string;
  event?: FakeEventLike;
  ephemeral?: FakeEventLike;
}

export function createFakeHomeserver(opts: FakeHomeserverOptions): FetchWithControls {
  const byToken = new Map(opts.accounts.map((a) => [a.accessToken, a]));
  const loggedOut = new Set<string>();
  const calls: FakeCallRecord[] = [];
  const queues = new Map<string, QueueItem[]>();
  const waiters = new Map<string, Array<() => void>>();
  const batches = new Map<string, number>();
  const stateStores = new Map<string, Map<string, Record<string, unknown>>>();
  const history = new Map<string, FakeEventLike[]>();
  let eventSeq = 1;
  let ts = Date.now();
  let sendFailure: { status: number; errcode: string } | null = null;

  const nextEventId = (): string => `$evt${eventSeq++}:hs.test`;

  const wake = (userId: string): void => {
    const list = waiters.get(userId) ?? [];
    waiters.delete(userId);
    for (const resolve of list) resolve();
  };

  const enqueue = (userId: string, item: QueueItem): void => {
    const q = queues.get(userId) ?? [];
    q.push(item);
    queues.set(userId, q);
    wake(userId);
  };

  /** Echo a room event to every account except the skip list (real-HS fanout). */
  const fanout = (ev: FakeEventLike, except?: string): void => {
    for (const a of opts.accounts) {
      if (a.userId === except) continue;
      enqueue(a.userId, { roomId: String(ev.room_id), event: ev });
    }
  };

  const roomState = (roomId: string): Map<string, Record<string, unknown>> => {
    let s = stateStores.get(roomId);
    if (!s) {
      s = new Map();
      stateStores.set(roomId, s);
    }
    return s;
  };

  /** Pull seeded timeline events out of the snapshot builder once per user so
   *  /relations and history agree with what /sync advertised (idempotent:
   *  makeSyncSnapshot is pure). */
  const seededUsers = new Set<string>();
  const seedHistoryFromSnapshot = (userId: string): void => {
    if (seededUsers.has(userId)) return;
    seededUsers.add(userId);
    const snap = (opts.sync ? opts.sync(userId) : makeSyncSnapshot({ userId })) as {
      rooms?: { join?: Record<string, { timeline?: { events?: Record<string, unknown>[] } }> };
    };
    for (const [roomId, body] of Object.entries(snap.rooms?.join ?? {})) {
      const evs = body.timeline?.events ?? [];
      const hist = history.get(roomId) ?? [];
      for (const e of evs) hist.push(e as unknown as FakeEventLike);
      history.set(roomId, hist);
    }
  };

  const record = (method: string, path: string, body: unknown): void => {
    calls.push({ method, path, body });
  };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const token = bearer(init);
    const account = token ? byToken.get(token) : undefined;

    // real spec list incl. v1.4: js-sdk gates thread support on v1.4 EXACT
    // membership (isVersionSupported does not interpolate between versions)
    if (path.endsWith("/versions")) return jsonRes({ versions: ["v1.1", "v1.2", "v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10", "v1.11"] });
    if (path.endsWith("/capabilities")) return jsonRes({ capabilities: {} });

    if (path.endsWith("/login") && method === "POST") {
      const body = await bodyJson(init);
      const identifier = body.identifier as { user?: string } | undefined;
      const loginUser = identifier?.user ?? (body.user as string | undefined);
      const hit = opts.accounts.find(
        (a) => a.userId === loginUser && a.password === body.password,
      );
      if (!hit) return jsonRes({ errcode: "M_FORBIDDEN", error: "Invalid password" }, 403);
      return jsonRes({
        access_token: hit.accessToken,
        device_id: hit.deviceId ?? "FAKEDEV",
        user_id: hit.userId,
      });
    }

    if (path.endsWith("/logout")) {
      if (token) loggedOut.add(token);
      return jsonRes({});
    }

    if (path.endsWith("/account/whoami")) {
      if (!account || loggedOut.has(account.accessToken)) {
        return jsonRes({ errcode: "M_UNKNOWN_TOKEN", error: "unknown token" }, 401);
      }
      return jsonRes({ user_id: account.userId });
    }

    if (path.endsWith("/filter")) return jsonRes({ filter_id: "fake-filter" });

    if (path.endsWith("/sync")) {
      if (!account) return jsonRes({ errcode: "M_UNKNOWN_TOKEN", error: "no token" }, 401);
      const userId = account.userId;
      if (!url.searchParams.get("since")) {
        const snapshot = opts.sync
          ? opts.sync(userId)
          : makeSyncSnapshot({ userId });
        return jsonRes(snapshot);
      }
      // long-poll: resolve when the queue has anything
      const drain = (): Response => {
        const q = queues.get(userId) ?? [];
        queues.set(userId, []);
        const byRoom = new Map<string, { timeline: FakeEventLike[]; ephemeral: FakeEventLike[] }>();
        for (const item of q) {
          const bucket = byRoom.get(item.roomId) ?? { timeline: [], ephemeral: [] };
          if (item.event) bucket.timeline.push(item.event);
          if (item.ephemeral) bucket.ephemeral.push(item.ephemeral);
          byRoom.set(item.roomId, bucket);
        }
        const n = (batches.get(userId) ?? 2) + 1;
        batches.set(userId, n);
        const join: Record<string, unknown> = {};
        for (const [roomId, bucket] of byRoom) {
          join[roomId] = {
            timeline: { events: bucket.timeline, limited: false, prev_batch: "b0" },
            ephemeral: { events: bucket.ephemeral },
            state: { events: [] },
          };
        }
        return jsonRes({
          next_batch: `b${n}`,
          rooms: { join, invite: {}, leave: {} },
          account_data: { events: [] },
          presence: { events: [] },
          to_device: { events: [] },
          device_lists: { changed: {}, left: {} },
          device_one_time_keys_count: {},
        });
      };
      if ((queues.get(userId) ?? []).length > 0) return drain();
      await new Promise<void>((resolve) => {
        const list = waiters.get(userId) ?? [];
        list.push(resolve);
        waiters.set(userId, list);
      });
      return drain();
    }

    if (!account) return jsonRes({ errcode: "M_UNKNOWN_TOKEN", error: "no token" }, 401);
    const userId = account.userId;

    // PUT /rooms/{roomId}/send/{type}/{txnId}
    const send = path.match(/\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/);
    if (send && method === "PUT") {
      record("PUT", path, await bodyJson(init));
      if (sendFailure) {
        const f = sendFailure;
        sendFailure = null;
        return jsonRes({ errcode: f.errcode, error: "injected" }, f.status);
      }
      const roomId = decodeURIComponent(send[1]!);
      const type = decodeURIComponent(send[2]!);
      const content = await bodyJson(init);
      const ev: FakeEventLike = {
        type,
        sender: userId,
        content,
        room_id: roomId,
        event_id: nextEventId(),
        origin_server_ts: ++ts,
      };
      const hist = history.get(roomId) ?? [];
      hist.push(ev);
      history.set(roomId, hist);
      fanout(ev);
      return jsonRes({ event_id: ev.event_id });
    }

    // PUT /rooms/{roomId}/redact/{eventId}/{txnId}
    const redact = path.match(/\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/);
    if (redact && method === "PUT") {
      record("PUT", path, await bodyJson(init));
      const roomId = decodeURIComponent(redact[1]!);
      const target = decodeURIComponent(redact[2]!);
      const ev: FakeEventLike = {
        type: "m.room.redaction",
        sender: userId,
        content: { redacts: target, reason: "redaction" },
        room_id: roomId,
        event_id: nextEventId(),
        origin_server_ts: ++ts,
        unsigned: {},
      };
      fanout(ev);
      return jsonRes({ event_id: ev.event_id });
    }

    // PUT /rooms/{roomId}/typing/{userId}
    if (/\/rooms\/[^/]+\/typing\/[^/]+$/.test(path) && method === "PUT") {
      record("PUT", path, await bodyJson(init));
      return jsonRes({});
    }

    // POST /rooms/{roomId}/receipt/m.read/{eventId}/user/{userId}
    if (/\/receipt\/m\.read\//.test(path) && method === "POST") {
      record("POST", path, await bodyJson(init));
      return jsonRes({});
    }

    // POST /join/{roomId} or /rooms/{roomId}/join
    const joinM = path.match(/\/join\/([^/]+)$/);
    const joinIn = path.match(/\/rooms\/([^/]+)\/join$/);
    if ((joinM || joinIn) && method === "POST") {
      record("POST", path, await bodyJson(init));
      const roomId = decodeURIComponent((joinM?.[1] ?? joinIn?.[1])!);
      fanout({
        type: "m.room.member",
        sender: userId,
        state_key: userId,
        content: { membership: "join" },
        room_id: roomId,
        event_id: nextEventId(),
        origin_server_ts: ++ts,
      });
      return jsonRes({ room_id: roomId });
    }

    // POST /rooms/{roomId}/invite
    const invite = path.match(/\/rooms\/([^/]+)\/invite$/);
    if (invite && method === "POST") {
      record("POST", path, await bodyJson(init));
      const body = await bodyJson(init);
      const roomId = decodeURIComponent(invite[1]!);
      const target = String(body["user_id"] ?? "");
      enqueue(target, {
        roomId,
        event: {
          type: "m.room.member",
          sender: userId,
          state_key: target,
          content: { membership: "invite" },
          room_id: roomId,
          event_id: nextEventId(),
          origin_server_ts: ++ts,
        },
      });
      return jsonRes({});
    }

    // GET/PUT /rooms/{roomId}/state/... — topic et al.
    const stateGet = path.match(/\/rooms\/([^/]+)\/state\/([^/]+)(?:\/([^/]*))?$/);
    if (stateGet) {
      const roomId = decodeURIComponent(stateGet[1]!);
      const type = decodeURIComponent(stateGet[2]!);
      const key = stateGet[3] === undefined ? "" : decodeURIComponent(stateGet[3]!);
      if (method === "GET") {
        const s = roomState(roomId).get(`${type}|${key}`);
        if (!s) return jsonRes({ errcode: "M_NOT_FOUND" }, 404);
        return jsonRes(s);
      }
      if (method === "PUT") {
        record("PUT", path, await bodyJson(init));
        const content = await bodyJson(init);
        roomState(roomId).set(`${type}|${key}`, content);
        const evId = nextEventId();
        fanout({
          type,
          sender: userId,
          state_key: key,
          content,
          room_id: roomId,
          event_id: evId,
          origin_server_ts: ++ts,
        });
        return jsonRes({ event_id: evId });
      }
    }

    // GET /rooms/{roomId}/messages?from&dir&limit — back-pagination
    const msgs = path.match(/\/rooms\/([^/]+)\/messages$/);
    if (msgs && method === "GET") {
      record("GET", path, null);
      const roomId = decodeURIComponent(msgs[1]!);
      const dir = url.searchParams.get("dir") ?? "b";
      const room = (opts.roomsLookup?.(userId) ?? []).find((r) => r.roomId === roomId);
      const old = room?.old ?? [];
      const chunk = dir === "b" ? old : [];
      const end = `b0-${old.length}`;
      return jsonRes({
        start: url.searchParams.get("from") ?? "b0",
        end,
        chunk: chunk.map((e, i) => ({
          depth: i + 1,
          prev_events: [],
          auth_events: [],
          unsigned: {},
          event_id: e.event_id ?? `$old-${roomId}-${i}`,
          origin_server_ts: e.origin_server_ts ?? 500 + i,
          room_id: roomId,
          ...e,
        })),
        state: [],
      });
    }

    // media upload — v3 /media/upload or /media/v3/upload
    if (/\/media(\/v3)?\/upload$/.test(path) && method === "POST") {
      record("POST", path, { size: typeof init?.body === "string" ? init.body.length : 0 });
      return jsonRes({ content_uri: `mxc://linnet.test/up${eventSeq++}` });
    }

    // GET /rooms/{roomId}/event/{eventId} — single event fetch (thread sends
    // resolve their root this way; returning {} stalls js-sdk)
    const eventGet = path.match(/\/rooms\/([^/]+)\/event\/([^/]+)$/);
    if (eventGet && method === "GET") {
      const roomId = decodeURIComponent(eventGet[1]!);
      const wantId = decodeURIComponent(eventGet[2]!);
      seedHistoryFromSnapshot(userId);
      const found = (history.get(roomId) ?? []).find((e) => e.event_id === wantId);
      if (!found) return jsonRes({ errcode: "M_NOT_FOUND", error: "not found" }, 404);
      return jsonRes({ ...found, room_id: roomId });
    }

    // GET /rooms/{roomId}/relations/{eventId}[/{relType}] — thread hydration
    const relations = path.match(/\/rooms\/([^/]+)\/relations\/([^/]+)(?:\/([^/]+))?$/);
    if (relations && method === "GET") {
      record("GET", path, null);
      const roomId = decodeURIComponent(relations[1]!);
      const target = decodeURIComponent(relations[2]!);
      const relType = relations[3] ? decodeURIComponent(relations[3]) : undefined;
      seedHistoryFromSnapshot(userId);
      const evs = (history.get(roomId) ?? []).filter((e) => {
        const rel = (e.content as Record<string, unknown>)?.["m.relates_to"] as Record<string, unknown> | undefined;
        if (!rel || rel["event_id"] !== target) return false;
        return !relType || rel["rel_type"] === relType;
      });
      // second page from our terminator token is EMPTY and carries no
      // next_batch — that is how js-sdk stops paginating
      if (url.searchParams.get("from") === "rel-end") return jsonRes({ chunk: [] });
      return jsonRes({ chunk: evs, next_batch: "rel-end" });
    }

    // /relations fallback (e.g. global MSC3675 form): empty but valid
    if (path.includes("/relations/")) return jsonRes({ chunk: [] });

    // anything else: benign {}
    record(method, path, method === "GET" ? null : await bodyJson(init));
    return jsonRes({});
  };

  const controls: FakeHomeserverControls = {
    calls,
    push(userId, roomId, ev) {
      const full: FakeEventLike = {
        event_id: ev.event_id ?? nextEventId(),
        origin_server_ts: ev.origin_server_ts ?? ++ts,
        room_id: roomId,
        ...ev,
      };
      const hist = history.get(roomId) ?? [];
      hist.push(full);
      history.set(roomId, hist);
      enqueue(userId, { roomId, event: full });
    },
    pushTyping(userId, roomId, members) {
      enqueue(userId, {
        roomId,
        ephemeral: { type: "m.typing", sender: "@server", content: { user_ids: members }, room_id: roomId },
      });
    },
    failNextSend(status, errcode) {
      sendFailure = { status, errcode: errcode ?? "M_UNKNOWN" };
    },
    resetCalls() {
      calls.length = 0;
    },
    nextEventId,
  };

  const fn = handler as unknown as FetchWithControls;
  (fn as unknown as { controls: FakeHomeserverControls }).controls = controls;
  return fn;
}

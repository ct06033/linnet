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
  /** W5b: seed m.room.create with room_type m.space */
  space?: boolean;
  /** W5b: m.space.child state events keyed by child room id */
  children?: Record<string, { order?: string; via?: string[] }>;
  /** W14 item 11: mxc URI seeded into m.room.avatar state */
  avatar?: string;
  /** P1 pinning: event ids seeded into m.room.pinned_events state */
  pinned?: string[];
  /** W14 item 6: initial room tags for the snapshot user (tagName -> meta) */
  tags?: Record<string, unknown>;
  /** W5b: replace the default m.room.power_levels content (PL-gating tests) */
  powerLevels?: Record<string, unknown>;
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
  /** P1 explore: rooms advertised by GET /publicRooms */
  publicRooms?: { roomId: string; name?: string; topic?: string; members?: number }[];
  accounts: FakeAccount[];
  /** First /sync body per user id; defaults to an empty snapshot. */
  sync?: (userId: string) => unknown;
  /** Per-user room feed for /messages back-pagination (the `old` arrays). */
  roomsLookup?(userId: string): Array<{ roomId: string; old?: FakeEventLike[] }>;
  /** W8: advertise m.login.sso with these IdPs; enables /login/sso/redirect. */
  sso?: { id: string; name: string; brand?: string }[];
  /** W15: seeds the MSC4143 /rtc/transports response. */
  rtcTransports?: { type: string; livekit_service_url?: string; url?: string }[];
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

function redirectRes(location: string): Response {
  return {
    ok: false,
    status: 302,
    statusText: "Found",
    headers: { get: (n: string) => (n.toLowerCase() === "location" ? location : null) },
    json: async () => ({}),
    text: async () => "",
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
  /** P1 presence: fake /sync presence events per user. */
  presence?: { userId: string; presence: string; statusMsg?: string; currentlyActive?: boolean; lastActiveAgo?: number }[];
  /** W6: extra global account_data events (type -> content). */
  accountData?: Record<string, Record<string, unknown>>;
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
      ev(
        roomId,
        "m.room.create",
        { creator: opts.userId, room_version: "11", ...(r.space ? { type: "m.space" } : {}) },
        { state_key: "" },
      ),
      ev(
        roomId,
        "m.room.power_levels",
        r.powerLevels ?? { users_default: 100, state_default: 0, events_default: 0, notifications: { room: 100 } },
        { state_key: "" },
      ),
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
    if (r.avatar) {
      out.push(ev(roomId, "m.room.avatar", { url: r.avatar }, { state_key: "" }));
    }
    if (r.pinned?.length) {
      out.push(ev(roomId, "m.room.pinned_events", { pinned: r.pinned }, { state_key: "" }));
    }
    // W5b: m.space.child links (state_key = child room id; via required to be active)
    for (const [childId, c] of Object.entries(r.children ?? {})) {
      out.push(
        ev(
          roomId,
          "m.space.child",
          { via: c.via ?? ["hs.test"], ...(c.order !== undefined ? { order: c.order } : {}) },
          { state_key: childId },
        ),
      );
    }
    return out;
  };
  const join: Record<string, unknown> = {};
  for (const r of opts.rooms ?? []) {
    join[r.roomId] = {
      state: { events: stateEvents(r.roomId, r) },
      ...(r.tags
        ? {
            tags: {
              events: [{ type: "m.tag", sender: opts.userId, room_id: r.roomId, content: { tags: r.tags } }],
            },
          }
        : {}),
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
      events: [
        ...(opts.direct ? [ev("$root", "m.direct", { [opts.userId]: opts.direct })] : []),
        ...Object.entries(opts.accountData ?? {}).map(([type, content]) => ev("$root", type, content)),
      ],
    },
    presence: {
      events: (opts.presence ?? []).map((p) => ({
        type: "m.presence",
        sender: p.userId,
        content: {
          presence: p.presence,
          ...(p.statusMsg ? { status_msg: p.statusMsg } : {}),
          currently_active: p.currentlyActive ?? p.presence === "online",
          last_active_ago: p.lastActiveAgo ?? (p.presence === "online" ? 1000 : 3_600_000),
        },
      })),
    },
    to_device: { events: [] },
    device_lists: { changed: {}, left: {} },
    device_one_time_keys_count: {},
  };
}

interface QueueItem {
  roomId: string;
  event?: FakeEventLike;
  ephemeral?: FakeEventLike;
  /** W5b: state events for a NEW room (from /createRoom) — delivered as
   *  rooms.join[roomId].state on the creator's next sync. */
  initialState?: Record<string, unknown>[];
  /** W6: global account data written via PUT /user/.../account_data/... */
  accountData?: { type: string; content: Record<string, unknown> };
  /** W7: to-device message relayed from PUT /sendToDevice */
  toDevice?: { type: string; sender: string; content: Record<string, unknown> };
  /** W14: rooms.join[roomId].tags block for the affected user's next sync */
  tags?: { events: Record<string, unknown>[] };
}

export function createFakeHomeserver(opts: FakeHomeserverOptions): FetchWithControls {
  const byToken = new Map(opts.accounts.map((a) => [a.accessToken, a]));
  const loggedOut = new Set<string>();
  // W8 SSO: loginToken -> userId minted by the fake /login/sso/redirect bounce
  const ssoTokens = new Map<string, string>();
  const calls: FakeCallRecord[] = [];
  const queues = new Map<string, QueueItem[]>();
  const waiters = new Map<string, Array<() => void>>();
  // W14 item 6: per-user room tags (userId -> roomId -> {tagName: meta}).
  const tagsStore = new Map<string, Map<string, Record<string, unknown>>>();
  // W14 item 11: userId -> profile content (display_name / avatar_url)
  const profiles = new Map<string, Record<string, unknown>>();
  const userTags = (uid: string): Map<string, Record<string, unknown>> => {
    let m = tagsStore.get(uid);
    if (!m) {
      m = new Map();
      tagsStore.set(uid, m);
    }
    return m;
  };
  const mkTagEvent = (uid: string, roomId: string): Record<string, unknown> => ({
    type: "m.tag",
    sender: uid,
    room_id: roomId,
    content: { tags: userTags(uid).get(roomId) ?? {} },
  });
  const batches = new Map<string, number>();
  const stateStores = new Map<string, Map<string, Record<string, unknown>>>();
  // W6: global account data per user (notification settings et al.)
  const accountStore = new Map<string, Map<string, Record<string, unknown>>>();
  const acctData = (userId: string): Map<string, Record<string, unknown>> => {
    let m = accountStore.get(userId);
    if (!m) accountStore.set(userId, (m = new Map()));
    return m;
  };
  const history = new Map<string, FakeEventLike[]>();
  let eventSeq = 1;
  // W4c: media bytes are STORED so download routes can serve them back
  const mediaStore = new Map<string, Uint8Array>();
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

    // P1 explore/join: the room directory
    if (path.endsWith("/publicRooms") && method === "GET") {
      const list = (opts.publicRooms ?? []).map((r) => ({
        room_id: r.roomId,
        name: r.name,
        topic: r.topic,
        num_joined_members: r.members ?? 1,
        world_readable: true,
        guest_can_join: true,
        aliases: [],
      }));
      return jsonRes({ chunk: list, total: list.length });
    }

    // W8 SSO: flow discovery (GET /login) + redirect bounce.
    // The fake "IdP" authenticates whoever the request names via fake_as=
    // (a test-only affordance; production code just window.location.assign's
    // whatever URL getSsoLoginUrl returns).
    if (path.endsWith("/login") && method === "GET") {
      if (!opts.sso) return jsonRes({ flows: [{ type: "m.login.password" }] });
      return jsonRes({
        flows: [
          { type: "m.login.password" },
          { type: "m.login.sso", identity_providers: opts.sso },
        ],
      });
    }
    if (path.includes("/login/sso/redirect") && method === "GET") {
      if (!opts.sso) return jsonRes({ errcode: "M_UNRECOGNIZED" }, 404);
      const redirectUrl = url.searchParams.get("redirectUrl") ?? "";
      const as = url.searchParams.get("fake_as") ?? opts.accounts[0]?.userId ?? "";
      const ssoToken = `ssotok-${ssoTokens.size + 1}`;
      ssoTokens.set(ssoToken, as);
      const sep = redirectUrl.includes("?") ? "&" : "?";
      return redirectRes(`${redirectUrl}${sep}loginToken=${ssoToken}`);
    }

    if (path.endsWith("/login") && method === "POST") {
      const body = await bodyJson(init);
      if (body.type === "m.login.token") {
        const ssoUser = ssoTokens.get(String(body.token ?? ""));
        if (!ssoUser) return jsonRes({ errcode: "M_FORBIDDEN", error: "invalid token" }, 403);
        ssoTokens.delete(String(body.token)); // one-time per spec
        const tokAccount = opts.accounts.find((a) => a.userId === ssoUser);
        if (!tokAccount) return jsonRes({ errcode: "M_FORBIDDEN", error: "unknown sso subject" }, 403);
        return jsonRes({
          access_token: tokAccount.accessToken,
          device_id: tokAccount.deviceId ?? "FAKEDEV",
          user_id: tokAccount.userId,
        });
      }
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
        // W14: replay this user's stored tags so favourites survive a restart
        // (spec: rooms.join[roomId].tags.events — the block js-sdk 45 ignores
        // and SessionManager.applyTagEvents reads instead).
        const joined = (snapshot as { rooms?: { join?: Record<string, unknown> } }).rooms?.join;
        if (joined) {
          for (const [rid, tags] of userTags(userId)) {
            if (!joined[rid] || Object.keys(tags).length === 0) continue;
            const body = joined[rid] as Record<string, unknown>;
            body["tags"] = { events: [mkTagEvent(userId, rid)] };
          }
        }
        return jsonRes(snapshot);
      }
      // long-poll: resolve when the queue has anything
      const drain = (): Response => {
        const q = queues.get(userId) ?? [];
        queues.set(userId, []);
        const byRoom = new Map<
          string,
          {
            timeline: FakeEventLike[];
            ephemeral: FakeEventLike[];
            state: Record<string, unknown>[];
            tags?: { events: Record<string, unknown>[] };
          }
        >();
        for (const item of q) {
          if (item.accountData || item.toDevice) continue;
          const bucket = byRoom.get(item.roomId) ?? { timeline: [], ephemeral: [], state: [] };
          if (item.event) bucket.timeline.push(item.event);
          if (item.ephemeral) bucket.ephemeral.push(item.ephemeral);
          if (item.initialState) bucket.state.push(...item.initialState);
          // W14: a tags-only item must still create its room bucket
          if (item.tags) bucket.tags = item.tags;
          byRoom.set(item.roomId, bucket);
        }
        const n = (batches.get(userId) ?? 2) + 1;
        batches.set(userId, n);
        const join: Record<string, unknown> = {};
        for (const [roomId, bucket] of byRoom) {
          join[roomId] = {
            timeline: { events: bucket.timeline, limited: false, prev_batch: "b0" },
            ephemeral: { events: bucket.ephemeral },
            state: { events: bucket.state },
            ...(bucket.tags ? { tags: bucket.tags } : {}),
          };
        }
        const adEvents = q
          .filter((i): i is QueueItem & { accountData: { type: string; content: Record<string, unknown> } } =>
            Boolean(i.accountData),
          )
          .map((i) => ({ type: i.accountData.type, sender: userId, content: i.accountData.content }));
        const tdEvents = q
          .filter((i): i is QueueItem & { toDevice: { type: string; sender: string; content: Record<string, unknown> } } =>
            Boolean(i.toDevice),
          )
          .map((i) => ({ type: i.toDevice.type, sender: i.toDevice.sender, content: i.toDevice.content }));
        return jsonRes({
          next_batch: `b${n}`,
          rooms: { join, invite: {}, leave: {} },
          account_data: { events: adEvents },
          presence: { events: [] },
          to_device: { events: tdEvents },
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
    if (/\/presence\/[^/]+\/status$/.test(path) && method === "PUT") {
      record("PUT", path, await bodyJson(init));
      return jsonRes({});
    }
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
      const joinEv: FakeEventLike = {
        type: "m.room.member",
        sender: userId,
        state_key: userId,
        content: { membership: "join" },
        room_id: roomId,
        event_id: nextEventId(),
        origin_server_ts: ++ts,
      };
      // W6: real HS transitions invite_state -> room state on join; deliver
      // the invite's state (sans membership) + own join echo so the joiner's
      // list shows a proper joined room, not a nameless husk
      const snap = (opts.sync ? opts.sync(userId) : {}) as {
        rooms?: { invite?: Record<string, { invite_state?: { events?: Record<string, unknown>[] } }> };
      };
      const carried = (snap.rooms?.invite?.[roomId]?.invite_state?.events ?? []).filter(
        (e) => e["type"] !== "m.room.member",
      );
      enqueue(userId, { roomId, event: joinEv, initialState: carried });
      fanout(joinEv, userId);
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

    // POST /createRoom — W5b: real room/space creation. Builds canonical
    // initial state (create/name/topic/join_rules/PL/member), stores it in
    // the room's state store and delivers it to the creator's next sync as a
    // fresh rooms.join entry (js-sdk creates the Room from it).
    if (path.endsWith("/createRoom") && method === "POST") {
      const body = await bodyJson(init);
      record("POST", path, body);
      const roomId = `!c${eventSeq++}:hs.test`;
      const mk = (type: string, key: string, content: Record<string, unknown>) => ({
        type,
        state_key: key,
        sender: userId,
        content,
        room_id: roomId,
        event_id: nextEventId(),
        origin_server_ts: ++ts,
      });
      const creation = (body.creation_content ?? {}) as Record<string, unknown>;
      const isPublic = body.visibility === "public" || body.preset === "public_chat";
      const events: Record<string, unknown>[] = [
        mk("m.room.create", "", { creator: userId, room_version: "11", ...creation }),
        mk("m.room.power_levels", "", {
          users: { [userId]: 100 },
          users_default: 100,
          state_default: 0,
          events_default: 0,
          notifications: { room: 100 },
        }),
        mk("m.room.member", userId, { membership: "join" }),
        mk("m.room.join_rules", "", { join_rule: isPublic ? "public" : "invite" }),
      ];
      if (typeof body.name === "string") events.push(mk("m.room.name", "", { name: body.name }));
      if (typeof body.topic === "string") events.push(mk("m.room.topic", "", { topic: body.topic }));
      for (const s of (body.initial_state ?? []) as Record<string, unknown>[]) {
        events.push(
          mk(String(s.type ?? ""), String(s.state_key ?? ""), (s.content ?? {}) as Record<string, unknown>),
        );
      }
      const store = roomState(roomId);
      for (const e of events) store.set(`${String(e.type)}|${String(e.state_key)}`, e.content as Record<string, unknown>);
      stateStores.set(roomId, store);
      enqueue(userId, { roomId, initialState: events });
      return jsonRes({ room_id: roomId });
    }

    // W7: PUT /sendToDevice/{type}/{txnId} — relay to every target user's
    // queue (device granularity ignored; the sending user is skipped, matching
    // real HS behaviour of not echoing to the originating device)
    const tdSend = path.match(/\/sendToDevice\/([^/]+)\/[^/]+$/);
    if (tdSend && method === "PUT") {
      const type = decodeURIComponent(tdSend[1]!);
      const body = (await bodyJson(init)) as { messages?: Record<string, Record<string, unknown>> };
      record("PUT", path, body);
      for (const [uid, byDevice] of Object.entries(body.messages ?? {})) {
        if (uid === account?.userId) continue;
        for (const content of Object.values(byDevice)) {
          const td: QueueItem["toDevice"] = {
            type,
            sender: account?.userId ?? "@unknown:hs.test",
            content: content as Record<string, unknown>,
          };
          // wake the target's parked sync even if they share this fetch server
          enqueue(uid, { roomId: "", toDevice: td });
        }
      }
      return jsonRes({});
    }

    // W7: GET /voip/turnServer — static fake creds (WebRTC tests never dial out)
    if (path.endsWith("/voip/turnServer") && method === "GET") {
      return jsonRes({ username: "fake", password: "fake", uris: ["stun:stun.fake.test:3478"], ttl: 86400 });
    }

    // W15: GET /rtc/transports — MatrixRTC (MSC4143) discovery; returns BOTH
    // stable {transports} and unstable {rtc_transports} keys so either client
    // path resolves. Seeded via FakeHomeserverOptions.rtcTransports.
    if (path.endsWith("/rtc/transports") && method === "GET") {
      const transports = opts.rtcTransports ?? [];
      return jsonRes({ transports, rtc_transports: transports });
    }

    // W14 item 11: GET/PUT /profile/{uid} — minimal profile store
    const profM = path.match(/\/profile\/([^/]+)(?:\/(avatar_url|display_name))?$/);
    if (profM && account) {
      const uid = decodeURIComponent(profM[1]!);
      if (method === "PUT") {
        const content = (await bodyJson(init)) as Record<string, unknown>;
        record("PUT", path, content);
        const field = profM[2];
        if (field) profiles.set(uid, { ...(profiles.get(uid) ?? {}), [field]: (content as Record<string, unknown>)[field] });
        else profiles.set(uid, { ...(profiles.get(uid) ?? {}), ...content });
        return jsonRes({});
      }
      if (method === "GET") return jsonRes(profiles.get(uid) ?? {});
    }

    // W14 item 6: GET/PUT/DELETE /user/{uid}/rooms/{roomId}/tags[/{tag}]
    const tagM = path.match(/\/user\/[^/]+\/rooms\/([^/]+)\/tags(?:\/([^/]+))?$/);
    if (tagM && account) {
      const rid = decodeURIComponent(tagM[1]!);
      const tagName = tagM[2] ? decodeURIComponent(tagM[2]!) : undefined;
      const mine = userTags(account.userId);
      if (method === "PUT") {
        const content = (await bodyJson(init)) as Record<string, unknown>;
        record("PUT", path, content);
        const set = { ...(mine.get(rid) ?? {}) };
        if (tagName) set[tagName] = content;
        mine.set(rid, set);
        enqueue(account.userId, { roomId: rid, tags: { events: [mkTagEvent(account.userId, rid)] } });
        return jsonRes({});
      }
      if (method === "DELETE" && tagName) {
        record("DELETE", path, null);
        const set = { ...(mine.get(rid) ?? {}) };
        delete set[tagName];
        mine.set(rid, set);
        enqueue(account.userId, { roomId: rid, tags: { events: [mkTagEvent(account.userId, rid)] } });
        return jsonRes({});
      }
      if (method === "GET") return jsonRes({ tags: mine.get(rid) ?? {} });
    }

    // W6: GET/PUT /user/{userId}/account_data/{type} — global settings storage
    const adM = path.match(/\/user\/[^/]+\/account_data\/([^/]+)$/);
    if (adM && account) {
      const type = decodeURIComponent(adM[1]!);
      const store = acctData(account.userId);
      if (method === "PUT") {
        const content = (await bodyJson(init)) as Record<string, unknown>;
        record("PUT", path, content);
        store.set(type, content);
        enqueue(account.userId, { roomId: "", accountData: { type, content } });
        return jsonRes(content);
      }
      if (method === "GET") {
        const hit = store.get(type);
        if (!hit) return jsonRes({ errcode: "M_NOT_FOUND" }, 404);
        return jsonRes(hit);
      }
    }

    // POST /rooms/{roomId}/leave — W5b: echo the leave membership back to the
    // leaver (real HS behaviour) so their room list updates, and to everyone
    // else via fanout.
    const leaveM = path.match(/\/rooms\/([^/]+)\/leave$/);
    if (leaveM && method === "POST") {
      record("POST", path, await bodyJson(init));
      const roomId = decodeURIComponent(leaveM[1]!);
      const evLeave: FakeEventLike = {
        type: "m.room.member",
        sender: userId,
        state_key: userId,
        content: { membership: "leave" },
        room_id: roomId,
        event_id: nextEventId(),
        origin_server_ts: ++ts,
      };
      enqueue(userId, { roomId, event: evLeave });
      fanout(evLeave, userId);
      return jsonRes({});
    }

    // POST /rooms/{roomId}/forget — record + benign {} (js-sdk drops the room
    // from its local store on 200)
    const forgetM = path.match(/\/rooms\/([^/]+)\/forget$/);
    if (forgetM && method === "POST") {
      record("POST", path, await bodyJson(init));
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
        const content = await bodyJson(init);
        record("PUT", path, content);
        roomState(roomId).set(`${type}|${key}`, content);
        const evId = nextEventId();
        const stEv: FakeEventLike = {
          type,
          sender: userId,
          state_key: key,
          content,
          room_id: roomId,
          event_id: evId,
          origin_server_ts: ++ts,
        };
        // real HS echoes state back to the SENDER too (own-echo drives local
        // room-state finalization; leave/createRoom do the same)
        enqueue(userId, { roomId, event: stEv });
        fanout(stEv, userId);
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

    // media upload — v3 /media/upload or /media/v3/upload (bytes stored,
    // ids served back through the download routes below)
    if (/\/media(\/v3)?\/upload$/.test(path) && (method === "POST" || method === "PUT")) {
      let bytes: Uint8Array;
      const b = init?.body;
      if (b == null) bytes = new Uint8Array();
      else if (typeof b === "string") bytes = new TextEncoder().encode(b);
      else if (b instanceof Uint8Array) bytes = b;
      else if (b instanceof ArrayBuffer) bytes = new Uint8Array(b);
      else if (typeof (b as Blob).arrayBuffer === "function")
        bytes = new Uint8Array(await (b as Blob).arrayBuffer());
      else bytes = new Uint8Array();
      const id = `up${eventSeq++}`;
      mediaStore.set(id, bytes);
      record(method, path, { size: bytes.length });
      return jsonRes({ content_uri: `mxc://linnet.test/${id}` });
    }

    // media download/thumbnail — authenticated (client/v1) + legacy routes.
    // Unknown id -> M_NOT_FOUND so app error states are testable.
    const mediaGet = path.match(/media\/(download|thumbnail)\/([^/]+)\/([^/?]+)/);
    if (mediaGet && method === "GET") {
      const bytes = mediaStore.get(mediaGet[3]!);
      if (!bytes) return jsonRes({ errcode: "M_NOT_FOUND", error: "media not found" }, 404);
      return new Response(bytes.slice() as unknown as BodyInit, {
        headers: { "Content-Type": "application/octet-stream" },
      });
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

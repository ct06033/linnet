/**
 * Minimal fake Matrix homeserver as a fetch replacement — wave-2 TESTS ONLY
 * (exported from the package so @linnet/app reuses the same seam; never use
 * in production code). Handles /versions, /login, /logout, /account/whoami,
 * /filter, /capabilities, /sync.
 */

export interface FakeAccount {
  userId: string;
  password: string;
  accessToken: string;
  deviceId?: string;
}

export interface FakeRoom {
  roomId: string;
  name: string;
}

export interface FakeInvite {
  roomId: string;
  name: string;
  inviter?: string;
}

export interface FakeHomeserverOptions {
  accounts: FakeAccount[];
  /** First /sync body per user id; defaults to an empty snapshot. */
  sync?: (userId: string) => unknown;
}

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
  const stateEvents = (roomId: string, name: string) => [
    ev(roomId, "m.room.create", { creator: opts.userId, room_version: "11" }, { state_key: "" }),
    ev(roomId, "m.room.power_levels", { users_default: 100, state_default: 0, events_default: 0, notifications: { room: 100 } }, { state_key: "" }),
    ev(roomId, "m.room.name", { name }, { state_key: "" }),
    ev(roomId, "m.room.member", { membership: "join" }, { state_key: opts.userId }),
  ];
  const join: Record<string, unknown> = {};
  for (const r of opts.rooms ?? []) {
    join[r.roomId] = {
      state: { events: stateEvents(r.roomId, r.name) },
      timeline: { events: [], limited: false, prev_batch: "b0" },
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

export function createFakeHomeserver(opts: FakeHomeserverOptions): typeof globalThis.fetch {
  const byToken = new Map(opts.accounts.map((a) => [a.accessToken, a]));
  const loggedOut = new Set<string>();

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const token = bearer(init);
    const account = token ? byToken.get(token) : undefined;

    if (path.endsWith("/versions")) return jsonRes({ versions: ["v1.11", "v1.2"] });
    if (path.endsWith("/capabilities")) return jsonRes({ capabilities: {} });

    if (path.endsWith("/login") && (init?.method ?? "GET") === "POST") {
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
      if (url.searchParams.get("since")) {
        // Park the sync loop so tests do not hot-spin; stopClient() cancels the timer.
        return jsonRes({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 3600000 }, 429);
      }
      const snapshot = opts.sync
        ? opts.sync(account.userId)
        : makeSyncSnapshot({ userId: account.userId });
      return jsonRes(snapshot);
    }

    return jsonRes({});
  };
  return handler as unknown as typeof globalThis.fetch;
}

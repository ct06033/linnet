/**
 * Pure timeline model: sender grouping, edit aggregation (m.replace latest
 * wins), reaction aggregation, reply detection, mention extraction, event
 * kind classification. Tested standalone against MatrixEvent instances.
 */
import { MatrixEvent, type Room } from "matrix-js-sdk";

export type EventKind =
  | "text"
  | "notice"
  | "emote"
  | "image"
  | "file"
  | "audio"
  | "video"
  | "system"
  | "redacted"
  | "utd"
  | "reaction"
  | "poll"
  | "unknown";

export function kindOf(ev: MatrixEvent): EventKind {
  if (ev.isRedacted()) return "redacted";
  if (ev.getType() === "m.reaction") return "reaction";
  if (ev.getType() === "m.poll.start") return "poll";
  if (ev.isState() && ev.getType() !== "m.room.message") return "system";
  if (ev.isEncrypted() && !ev.getClearContent()) return "utd";
  const msgtype = rawContentOf(ev)["msgtype"] as string | undefined;
  switch (msgtype) {
    case "m.notice": return "notice";
    case "m.emote": return "emote";
    case "m.image": return "image";
    case "m.file": return "file";
    case "m.audio": return "audio";
    case "m.video": return "video";
    case "m.text": return "text";
    default:
      if (ev.getType() === "m.sticker") return "image";
      return "unknown";
  }
}

export function bodyOf(ev: MatrixEvent): string {
  const content = rawContentOf(ev);
  return String(content["body"] ?? "");
}

/**
 * Display body: for replies, strip the leading "> …" fallback-quote block
 * (the chip renders it instead). Same convention as Element/Cinny.
 */
export function displayBody(ev: MatrixEvent): string {
  const body = bodyOf(ev);
  if (!replyTargetId(ev)) return body;
  return body.replace(/^(>.*(\n|$))+/, "").trimStart();
}

export function rawContentOf(ev: MatrixEvent): Record<string, unknown> {
  const clear = ev.getClearContent() as unknown as Record<string, unknown> | null;
  return clear ?? (ev.getContent() as Record<string, unknown>);
}

export function formattedBodyOf(ev: MatrixEvent): string | undefined {
  const content = rawContentOf(ev);
  if (content["format"] === "org.matrix.custom.html" && typeof content["formatted_body"] === "string") {
    return content["formatted_body"];
  }
  return undefined;
}

/** Edits: latest m.replace per target wins; edited targets render new content. */
export function latestEdits(events: MatrixEvent[]): Map<string, MatrixEvent> {
  const out = new Map<string, MatrixEvent>();
  for (const ev of events) {
    const rel = (ev.getContent()?.["m.relates_to"] ?? {}) as Record<string, unknown>;
    if (rel["key"] !== undefined && rel["event_id"] && rel["is_falling_back"] !== undefined) continue; // thread root marker
    if (rel["rel_type"] === "replace" && typeof rel["event_id"] === "string") {
      const prev = out.get(rel["event_id"]);
      if (!prev || (prev.getTs() ?? 0) <= (ev.getTs() ?? 0)) out.set(rel["event_id"], ev);
    }
  }
  return out;
}

export interface ReactionAgg {
  count: number;
  mine: boolean;
  key: string;
}

export function aggregateReactions(events: MatrixEvent[], myUserId: string | null): Map<string, ReactionAgg[]> {
  const byTarget = new Map<string, Map<string, ReactionAgg>>();
  for (const ev of events) {
    if (kindOf(ev) !== "reaction") continue;
    const c = ev.getContent();
    const rel = (c["m.relates_to"] ?? {}) as Record<string, unknown>;
    if (rel["rel_type"] !== "annotation" || typeof rel["event_id"] !== "string") continue;
    // spec: emoji lives in rel.key; tolerate legacy content.value
    const key = String(rel["key"] ?? c["value"] ?? "");
    const inner = byTarget.get(rel["event_id"]) ?? new Map<string, ReactionAgg>();
    const agg = inner.get(key) ?? { count: 0, mine: false, key };
    agg.count += 1;
    if (ev.getSender() === myUserId) agg.mine = true;
    inner.set(key, agg);
    byTarget.set(rel["event_id"], inner);
  }
  const out = new Map<string, ReactionAgg[]>();
  for (const [target, inner] of byTarget) out.set(target, [...inner.values()]);
  return out;
}

export function replyTargetId(ev: MatrixEvent): string | null {
  const rel = (ev.getContent()?.["m.relates_to"] ?? {}) as Record<string, unknown>;
  const inReplyTo = rel["m.in_reply_to"] as { event_id?: string } | undefined;
  return inReplyTo?.event_id ?? null;
}

/** True for events joined to a thread (rel_type: thread). */
export function threadRootId(ev: MatrixEvent): string | null {
  const rel = (ev.getContent()?.["m.relates_to"] ?? {}) as Record<string, unknown>;
  return rel["rel_type"] === "m.thread" && typeof rel["event_id"] === "string" ? rel["event_id"] : null;
}

export function isThreadReply(ev: MatrixEvent): boolean {
  return threadRootId(ev) !== null;
}

/* ── Polls (MSC3381, Matrix v1.7 stable shapes) ──────────────── */

export interface PollStartInfo {
  question: string;
  answers: { id: string; text: string }[];
  maxSelections: number;
}

export interface PollState {
  start: PollStartInfo;
  votes: Map<string, number>; // answerId -> count
  voters: Set<string>;
  myVote: string[];
  ended: boolean;
  endedBy?: string;
}

const POLL_ANSWER_ID = (a: unknown, i: number): string => {
  const rec = a as Record<string, unknown>;
  return String(rec["id"] ?? i);
};

export function parsePollStart(ev: MatrixEvent): PollStartInfo | null {
  if (ev.getType() !== "m.poll.start") return null;
  const c = rawContentOf(ev);
  const question = c["question"] as Record<string, unknown> | undefined;
  const answers = Array.isArray(c["answers"]) ? (c["answers"] as unknown[]) : [];
  if (!question || answers.length === 0) return null;
  return {
    question: String(question["body"] ?? ""),
    answers: answers.map((a, i) => ({
      id: POLL_ANSWER_ID(a, i),
      text: String((a as Record<string, unknown>)["body"] ?? (a as Record<string, unknown>)["m.text"] ?? ""),
    })),
    maxSelections: Number((c["max_selections"] as number | undefined) ?? 1),
  };
}

function referenceId(ev: MatrixEvent): string | null {
  const rel = (ev.getContent() as Record<string, unknown>)["m.relates_to"] as Record<string, unknown> | undefined;
  if (rel?.["rel_type"] === "m.reference" && typeof rel["event_id"] === "string") return rel["event_id"];
  return null;
}

/** Latest response per user wins; ends flip state; only own votes surface. */
export function aggregatePolls(events: MatrixEvent[], myUserId: string | null): Map<string, PollState> {
  const polls = new Map<string, PollState>();
  for (const ev of events) {
    const start = parsePollStart(ev);
    const id = ev.getId();
    if (start && id) {
      polls.set(id, { start, votes: new Map(), voters: new Set(), myVote: [], ended: false });
    }
  }
  if (polls.size === 0) return polls;
  const latestByUser = new Map<string, { ts: number; answers: string[]; sender: string }>();
  for (const ev of events) {
    if (ev.getType() === "m.poll.end") {
      const target = referenceId(ev);
      const poll = target ? polls.get(target) : undefined;
      if (poll) {
        poll.ended = true;
        poll.endedBy = ev.getSender() ?? undefined;
      }
      continue;
    }
    if (ev.getType() !== "m.poll.response") continue;
    const target = referenceId(ev);
    if (!target || !polls.has(target)) continue;
    const sender = ev.getSender();
    if (!sender) continue;
    const answers = Array.isArray((ev.getContent() as Record<string, unknown>)["answers"])
      ? ((ev.getContent() as Record<string, unknown>)["answers"] as unknown[]).map(String)
      : [];
    const key = `${target}|${sender}`;
    const prev = latestByUser.get(key);
    if (!prev || prev.ts <= ev.getTs()) latestByUser.set(key, { ts: ev.getTs(), answers, sender });
  }
  for (const [key, rec] of latestByUser) {
    const targetId = key.split("|")[0]!;
    const poll = polls.get(targetId)!;
    poll.voters.add(rec.sender);
    for (const a of rec.answers) poll.votes.set(a, (poll.votes.get(a) ?? 0) + 1);
    if (rec.sender === myUserId) poll.myVote = rec.answers;
  }
  return polls;
}

export function isPollChild(ev: MatrixEvent): boolean {
  const t = ev.getType();
  return t === "m.poll.response" || t === "m.poll.end";
}

export interface EventGroup {
  sender: string;
  events: MatrixEvent[];
}

/** Same sender within 5 minutes groups together; system lines stand alone. */
export function groupEvents(events: MatrixEvent[], windowMs = 5 * 60_000): EventGroup[] {
  const groups: EventGroup[] = [];
  for (const ev of events) {
    const k = kindOf(ev);
    const last = groups[groups.length - 1];
    if (
      last &&
      k !== "system" &&
      k !== "redacted" &&
      last.events[last.events.length - 1] &&
      kindOf(last.events[last.events.length - 1]!) !== "system" &&
      last.sender === (ev.getSender() ?? "?") &&
      ev.getTs() - (last.events[last.events.length - 1]!.getTs()) < windowMs
    ) {
      last.events.push(ev);
    } else {
      groups.push({ sender: ev.getSender() ?? "?", events: [ev] });
    }
  }
  return groups;
}

/** Extract mentioned mx IDs from @user:text tokens against room members. */
export function detectMentions(text: string, room: Room | null, myUserId: string | null): {
  userIds: string[];
  atRoom: boolean;
} {
  const userIds = new Set<string>();
  let atRoom = false;
  const rawMembers = room?.getJoinedMembers?.() ?? {};
  // js-sdk 45 returns an ARRAY of RoomMember here (docs still say dict — probed)
  const memberIds = Array.isArray(rawMembers)
    ? (rawMembers as Array<{ userId?: string }>).map((m) => m.userId ?? "")
    : Object.keys(rawMembers as Record<string, unknown>);
  const localMatches = (needle: string): string[] => {
    const local = needle.replace(/^@/, "");
    const full = local.includes(":") ? local : myUserId ? local + ":" + myUserId.split(":").slice(1).join(":") : local;
    return memberIds.filter(
      (uid) => uid === `@${full}` || uid.split(":")[0] === `@${local}`,
    );
  };
  const tokenRe = /@([A-Za-z0-9._=\-+/]+(?::[A-Za-z0-9.\-]+)?)/g;
  for (const m of text.matchAll(tokenRe)) {
    const needle = m[0].slice(1);
    if (needle === "room") {
      atRoom = true;
      continue;
    }
    for (const uid of localMatches(needle)) userIds.add(uid);
  }
  return { userIds: [...userIds], atRoom };
}

/** @room only honored if the sender holds the notify power (notifications.room). */
export function canNotifyRoom(_client: unknown, room: Room | null, userId: string | null): boolean {
  if (!room || !userId) return false;
  const plEv = room.currentState.getStateEvents("m.room.power_levels", "");
  const content = (plEv?.getContent?.() ?? {}) as Record<string, unknown>;
  const users = (content["users"] ?? {}) as Record<string, number>;
  const usersDefault = (content["users_default"] as number) ?? 0;
  const events = (content["events"] ?? {}) as Record<string, number>;
  const notif = (content["notifications"] as Record<string, number> | undefined) ?? {};
  const roomLevel = notif["room"] ?? events["m.room.message"] ?? 100;
  const level = users[userId] ?? usersDefault;
  return level >= roomLevel;
}

export function displayNameOf(client: { getUser: (id: string) => unknown }, userId: string): string {
  const u = client.getUser(userId) as { display_name?: string } | null;
  return u?.display_name ?? userId.split(":")[0]?.replace(/^@/, "") ?? userId;
}

export function makeEvent(template: {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  event_id?: string;
  room_id?: string;
  ts?: number;
  state_key?: string;
  redacted_because?: unknown;
}): MatrixEvent {
  const ev = new MatrixEvent({
    type: template.type,
    sender: template.sender,
    content: template.content,
    event_id: template.event_id ?? "$t",
    room_id: template.room_id ?? "!r:hs.test",
    origin_server_ts: template.ts ?? 1000,
    state_key: template.state_key,
    unsigned: (template.redacted_because
      ? { redacted_because: template.redacted_because }
      : {}) as never,
  });
  return ev;
}

/**
 * W6 — engine: listens to the js-sdk timeline, applies the pure rules, and
 * fires through an injected Notifier port (browser Notification in prod,
 * a recording spy in tests). Suppresses: own sends, edits, redactions, and
 * historical catch-up (age > 30s) so initial sync never spam-notifies.
 */
import {
  ClientEvent,
  EventType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { readPrefs, shouldNotify, PREFS_KEY, type Candidate, type NotifyPrefs } from "./model.js";

export interface Notification {
  roomId: string;
  title: string;
  body: string;
}

export interface Notifier {
  notify(n: Notification): void;
}

export interface EngineHooks {
  /** room the user is currently looking at — suppresses its notifications */
  isFocused(roomId: string): boolean;
}

const HISTORY_AGE_MS = 30_000;

export class NotificationEngine {
  private readonly client: MatrixClient;
  private readonly notifier: Notifier;
  private readonly hooks: Partial<EngineHooks>;
  private prefs: NotifyPrefs = { modes: {}, keywords: [] };
  private running = false;

  constructor(client: MatrixClient, notifier: Notifier, hooks: Partial<EngineHooks> = {}) {
    this.client = client;
    this.notifier = notifier;
    this.hooks = hooks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.prefs = readPrefs(this.client);
    this.client.on(RoomEvent.Timeline, this.onTimeline);
    this.client.on(ClientEvent.AccountData, this.onAccountData);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.client.removeListener(RoomEvent.Timeline, this.onTimeline);
    this.client.removeListener(ClientEvent.AccountData, this.onAccountData);
  }

  private onAccountData = (event: MatrixEvent): void => {
    if (event.getType() === PREFS_KEY) this.prefs = readPrefs(this.client);
  };

  /** Exported for tests that feed synthetic events; the Timeline listener
   *  routes through it. */
  handle(ev: MatrixEvent, room: Room | null): void {
    if (!this.running || !room) return;
    if (ev.getType() !== EventType.RoomMessage) return;
    if (ev.isRedacted()) return;
    const content = ev.getContent() as Record<string, unknown>;
    if (content["m.new_content"]) return; // edit, not a new message
    // getAge() is undefined for locally-built events (js-sdk quirk) — derive
    // from server ts
    const age = Date.now() - ev.getTs();
    if (Number.isFinite(age) && age > HISTORY_AGE_MS) return; // catch-up spam guard
    if (this.hooks.isFocused?.(room.roomId)) return;

    const me = this.client.getUserId() ?? "";
    const body = String(content["body"] ?? "");
    const mentions = (content["m.mentions"] ?? {}) as { user_ids?: string[]; room?: boolean };
    const displayName = this.client.getUser(me)?.displayName ?? "";
    const mentioned =
      (mentions.user_ids?.includes(me) ?? false) ||
      (body.includes(me) && !body.includes("@" + "room")) ||
      (displayName !== "" && body.includes(displayName));
    const c: Candidate = {
      roomId: room.roomId,
      roomName: room.name || room.roomId,
      isDM: room.getDMInviter() != null || readDM(this.client, room.roomId),
      sender: ev.getSender() ?? "?",
      body,
      own: ev.getSender() === me,
      edit: false,
      redacted: false,
      mentionsYou: mentioned || Boolean(mentions.room),
      mentionsRoom: Boolean(mentions.room),
    };
    if (!shouldNotify(c, this.prefs)) return;
    const local = c.sender.split(":")[0]?.replace("@", "") ?? c.sender;
    this.notifier.notify({
      roomId: c.roomId,
      title: c.roomName,
      body: `${local}: ${body.slice(0, 120)}`,
    });
  }

  private onTimeline = (event: MatrixEvent, room: Room | undefined, toStartOfTimeline: boolean | unknown): void => {
    if (toStartOfTimeline) return; // back-pagination is never a "new" message
    this.handle(event, room ?? null);
  };
}

/** m.direct map check without importing session internals. */
function readDM(client: MatrixClient, roomId: string): boolean {
  const me = client.getUserId();
  const ev = client.getAccountData("m.direct" as never);
  const map = (ev?.getContent() ?? {}) as Record<string, string[]>;
  return me ? (map[me] ?? []).includes(roomId) : false;
}

/** Browser/OS port; Tauri/Electron-native upgrades land with W8. */
export function makeNotifierPort(): Notifier {
  const Ctor = typeof globalThis.Notification !== "undefined" ? globalThis.Notification : null;
  return {
    notify: (n) => {
      try {
        if (Ctor) new Ctor(n.title, { body: n.body, tag: n.roomId });
      } catch {
        /* permission denied / unsupported — desktop shell owns this in W8 */
      }
    },
  };
}

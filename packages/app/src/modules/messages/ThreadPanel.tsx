/**
 * ThreadPanel: right-docked pane rendering a thread root + its replies and a
 * thread-scoped composer (MSC3440 relation sends). Content bodies go through
 * the same registry timeline-item contributions as the main timeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EventType,
  RoomEvent,
  ThreadEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import type { ModuleRegistry, TimelineItemContribution } from "@linnet/core";
import {
  aggregateReactions,
  bodyOf,
  displayNameOf,
  kindOf,
  latestEdits,
  replyTargetId,
} from "./model.js";
import type { TimelineItemProps } from "./renderers.js";
import { drafts } from "./Composer.js";

export interface ThreadPanelProps {
  client: MatrixClient;
  room: Room;
  threadId: string;
  registry: ModuleRegistry | null;
  myUserId: string | null;
  onClose: () => void;
}

export function ThreadPanel({ client, room, threadId, registry, myUserId, onClose }: ThreadPanelProps): JSX.Element | null {
  const [tick, setTick] = useState(0);
  const [value, setValue] = useState(() => drafts.get(threadKey(room.roomId, threadId)) ?? "");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const thread = room.getThreads().find((t) => t.id === threadId);
    const onReply = (): void => bump();
    const onAny = (ev?: MatrixEvent): void => {
      if (!ev || ev.getRoomId() === room.roomId) bump();
    };
    const offs: Array<() => void> = [];
    if (thread) {
      thread.on(ThreadEvent.Update, onReply);
      thread.on(ThreadEvent.NewReply, onReply);
      offs.push(() => {
        thread.removeListener(ThreadEvent.Update, onReply);
        thread.removeListener(ThreadEvent.NewReply, onReply);
      });
    }
    client.on(RoomEvent.Timeline, onAny);
    return () => {
      client.removeListener(RoomEvent.Timeline, onAny);
      for (const off of offs) off();
    };
  }, [client, room, threadId, bump]);

  const thread = room.getThreads().find((t) => t.id === threadId);
  const events: MatrixEvent[] = useMemo(() => (thread ? [...thread.events] : []), [thread, tick]);
  const root = thread?.rootEvent ?? room.findEventById(threadId) ?? events.find((e) => e.getId() === threadId) ?? null;
  const replies = events.filter((e) => e.getId() !== threadId);
  const edits = useMemo(() => latestEdits(events), [events]);
  const reactions = useMemo(() => aggregateReactions(events, myUserId), [events, myUserId]);
  const participants = useMemo(() => {
    const ids = new Set<string>();
    for (const e of replies) if (e.getSender()) ids.add(e.getSender()!);
    return [...ids];
  }, [replies]);

  useEffect(() => {
    areaRef.current?.focus();
  }, [threadId]);

  async function send(): Promise<void> {
    const text = value.trim();
    if (!text || !root?.getId()) return;
    setValue("");
    drafts.set(threadKey(room.roomId, threadId), "");
    const rootId = root.getId()!;
    const quote = `> <${root.getSender() ?? "?"}> ${bodyOf(root).slice(0, 200).replace(/\n/g, "\n> ")}\n\n${text}`;
    try {
      // official threading overload: js-sdk builds the m.thread relation +
      // is_falling_back itself (hand-built relations get rewritten)
      await client.sendEvent(room.roomId, rootId, EventType.RoomMessage, {
        msgtype: "m.text",
        body: quote,
        "m.relates_to": { "m.in_reply_to": { event_id: lastReplyId(replies) ?? rootId } },
      } as never);
    } catch (err) {
      console.warn("linnet: thread reply failed", err);
    }
  }

  if (!root) {
    return (
      <aside className="thread-panel" data-testid="thread-panel">
        <header>
          <span>Thread</span>
          <button aria-label="Close thread" onClick={onClose}>✕</button>
        </header>
        <p className="placeholder">thread not found (maybe redacted)</p>
      </aside>
    );
  }

  const renderEvent = (ev: MatrixEvent): JSX.Element => {
    const kind = kindOf(ev);
    const contrib = registry?.list("timeline-item").find((c: TimelineItemContribution) => c.kind === kind);
    const editEv = ev.getId() ? edits.get(ev.getId()!) : undefined;
    const replyTo = replyTargetId(ev);
    const parent = replyTo ? events.find((e) => e.getId() === replyTo) : undefined;
    const props: TimelineItemProps = {
      ev,
      client,
      myUserId,
      edited: Boolean(editEv),
      editContent: editEv?.getContent()?.["m.new_content"] as Record<string, unknown> | undefined,
      replyTarget: parent ? { senderName: shortOf(parent.getSender() ?? "?"), body: bodyOf(parent) } : null,
      reactions: (ev.getId() && reactions.get(ev.getId()!)) || [],
      onReact: () => undefined, // in-thread reactions land with the picker pass
    };
    return (
      <div className="row" key={ev.getId() ?? "r"}>
        <div className="who">
          <span className="avatar">{shortOf(ev.getSender() ?? "?").slice(0, 2).toUpperCase()}</span>
          <strong>{displayNameOf(client, ev.getSender() ?? "?")}</strong>
          <time>{new Date(ev.getTs()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <div className="content">{contrib ? (contrib.render(props) as JSX.Element) : <em className="muted">{kind}</em>}</div>
      </div>
    );
  };

  return (
    <aside className="thread-panel" data-testid="thread-panel">
      <header>
        <span>
          Thread · {replies.length} {replies.length === 1 ? "reply" : "replies"}
          {participants.length > 0 && <em className="parts"> · {participants.map(shortOf).join(", ")}</em>}
        </span>
        <button aria-label="Close thread" onClick={onClose}>✕</button>
      </header>
      <div className="thread-scroll">
        <div className="thread-root">{renderEvent(root)}</div>
        {replies.map((ev) => renderEvent(ev))}
        {replies.length === 0 && <p className="placeholder">No replies yet — start the discussion.</p>}
      </div>
      <footer className="composer thread-composer">
        <textarea
          ref={areaRef}
          aria-label="Reply to thread"
          rows={2}
          placeholder="Reply to thread…"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            drafts.set(threadKey(room.roomId, threadId), e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button onClick={() => void send()} disabled={!value.trim()} aria-label="Send thread reply">
          Reply
        </button>
      </footer>
    </aside>
  );
}

function shortOf(uid: string): string {
  return uid.split(":")[0]?.replace(/^@/, "") ?? uid;
}

function lastReplyId(replies: MatrixEvent[]): string | null {
  for (let i = replies.length - 1; i >= 0; i--) {
    const id = replies[i]!.getId();
    if (id) return id;
  }
  return null;
}

export function threadKey(roomId: string, threadId: string): string {
  return `${roomId}::${threadId}`;
}

export { draftOf };
function draftOf(key: string): string {
  return drafts.get(key) ?? "";
}

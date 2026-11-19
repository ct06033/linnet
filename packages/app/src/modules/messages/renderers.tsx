/**
 * linnet.messages — timeline-item renderers registered through the public
 * seam (PRD §6.9 API honesty). RoomView owns layout chrome; these own content
 * bodies per EventKind.
 */
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { useState, type ReactNode } from "react";
import type { LinnetModule, TimelineItemContribution } from "@linnet/core";
import { sanitizeHtml } from "./html.js";
import { ImageBody, VoiceBody, FileBody } from "../media/renderers.js";
import { stripFallbackQuote } from "./markdown.js";
import {
  aggregateReactions,
  bodyOf,
  formattedBodyOf,
  kindOf,
  latestEdits,
  rawContentOf,
  replyTargetId,
  type EventKind,
  type PollState,
  type ReactionAgg,
} from "./model.js";
import { EmojiPicker } from "./EmojiPicker.js";

export interface TimelineItemProps {
  ev: MatrixEvent;
  client: MatrixClient;
  myUserId: string | null;
  edited: boolean;
  editContent?: Record<string, unknown>;
  replyTarget?: { senderName: string; body: string } | null;
  reactions: ReactionAgg[];
  onReact: (target: MatrixEvent, key: string) => void;
  poll?: PollState;
  onVote?: (target: MatrixEvent, answerId: string) => void;
  onEndPoll?: (target: MatrixEvent) => void;
  onOpenImage?: (evId: string) => void;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🔥", "👀"];

function renderBody(props: TimelineItemProps, ev: MatrixEvent): ReactNode {
  // edits render latest content with an "(edited)" badge
  const useContent = props.editContent ?? rawContentOf(ev);
  const formatted =
    useContent["format"] === "org.matrix.custom.html" && typeof useContent["formatted_body"] === "string"
      ? (useContent["formatted_body"] as string)
      : undefined;
  // fallback-quote lines are dropped when the relation exists (chip shows it)
  let body = String(useContent["body"] ?? "");
  if (props.replyTarget) body = body.replace(/^(>.*(\n|$))+/, "").trimStart();
  return (
    <div className="msg-body" data-testid={`msg-${props.ev.getId()}`}>
      {props.replyTarget && (
        <div className="reply-quote" title={`Reply to ${props.replyTarget.senderName}`}>
          ↳ {props.replyTarget.senderName}: {props.replyTarget.body.slice(0, 80)}
        </div>
      )}
      {formatted !== undefined ? (
        <div
          className="formatted"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(stripFallbackQuote(formatted)) }}
        />
      ) : (
        <span className="plain">{body}</span>
      )}
      {props.edited && <span className="edited-badge" title="edited"> (edited)</span>}
    </div>
  );
}

function ReactionRow(props: TimelineItemProps): ReactNode {
  const { ev, reactions, onReact } = props;
  const [picking, setPicking] = useState(false);
  return (
    <div className="reactions" data-testid={`reactions-${ev.getId()}`}>
      {reactions.map((r) => (
        <button
          key={r.key}
          className={`reaction-pill${r.mine ? " mine" : ""}`}
          onClick={() => onReact(ev, r.key)}
          title={r.mine ? "remove your reaction" : r.key}
        >
          {r.key} {r.count}
        </button>
      ))}
      <span className="quick-react" role="group" aria-label="quick reactions">
        {QUICK_REACTIONS.slice(0, 4).map((k) => (
          <button key={k} className="qr" onClick={() => onReact(ev, k)} aria-label={`react ${k}`}>
            {k}
          </button>
        ))}
        <button className="qr" onClick={() => setPicking((v) => !v)} aria-label="more reactions">
          ➕
        </button>
        {picking && (
          <span className="picker-anchor">
            <EmojiPicker label="Reaction picker" onSelect={(c) => onReact(ev, c)} onClose={() => setPicking(false)} />
          </span>
        )}
      </span>
    </div>
  );
}

function TextLike(kind: "text" | "notice" | "emote") {
  return (props: unknown): ReactNode => {
    const p = props as TimelineItemProps;
    const body = renderBody(p, p.ev);
    return (
      <div className={`msg msg-${kind}${kind === "notice" ? " notice" : ""}`}>
        {kind === "emote" ? <span className="emote-star">* </span> : null}
        {body}
        <ReactionRow {...p} />
      </div>
    );
  };
}

function MediaBody(props: unknown): ReactNode {
  const p = props as TimelineItemProps;
  const content = p.editContent ?? rawContentOf(p.ev);
  const msgtype = String(content["msgtype"] ?? kindOf(p.ev));
  const info = (content["info"] as Record<string, unknown>) ?? {};
  const isVoice =
    msgtype === "m.audio" &&
    (content["org.matrix.msc3245.voice"] !== undefined || info["org.matrix.msc1767.audio"] !== undefined || info.json !== undefined);
  const mp = { ev: p.ev, client: p.client, content, onOpenImage: p.onOpenImage };
  const inner =
    msgtype === "m.image" ? <ImageBody {...mp} /> : isVoice ? <VoiceBody {...mp} /> : <FileBody {...mp} />;
  return (
    <>
      {inner}
      <ReactionRow {...p} />
    </>
  );
}

function shortOf(uid: string): string {
  return uid.split(":")[0]?.replace(/^@/, "") ?? uid;
}

function SystemBody(props: unknown): ReactNode {
  const { ev } = props as TimelineItemProps;
  const sender = shortOf(ev.getSender() ?? "?");
  const content = ev.getContent() as Record<string, unknown>;
  let text = `${sender} · ${ev.getType()}`;
  if (ev.getType() === "m.room.member") {
    const target = shortOf(ev.getStateKey() ?? "");
    const m = String(content["membership"] ?? "");
    text =
      m === "join" ? `${target} joined`
      : m === "leave" ? `${target} left`
      : m === "invite" ? `${target} was invited`
      : `${target}: ${m}`;
  } else if (ev.getType() === "m.room.topic") {
    text = `${sender} changed the topic`;
  } else if (ev.getType() === "m.room.name") {
    text = `${sender} renamed the room`;
  }
  return <div className="system-line">{text}</div>;
}

function UtdBody(props: unknown): ReactNode {
  const { ev } = props as TimelineItemProps;
  return (
    <div className="msg msg-utd" data-testid={`utd-${ev.getId()}`}>
      🔒 Unable to decrypt
      <span className="utd-hint"> — this message is encrypted; key backup/verification help lands in Settings</span>
    </div>
  );
}

function RedactedBody(props: unknown): ReactNode {
  const { ev } = props as TimelineItemProps;
  return <div className="msg msg-redacted" data-testid={`redacted-${ev.getId()}`}>Message deleted</div>;
}

function UnknownBody(props: unknown): ReactNode {
  const { ev } = props as TimelineItemProps;
  const b = bodyOf(ev);
  return (
    <div className="msg msg-unknown">
      {b || <span className="plain">[unsupported event: {ev.getType()}]</span>}
      {b && <span className="unsupported-tag">({ev.getType()})</span>}
    </div>
  );
}

function PollBody(props: unknown): ReactNode {
  const p = props as TimelineItemProps;
  const poll = p.poll;
  if (!poll) return <div className="msg msg-poll placeholder">Poll (loading…)</div>;
  const total = poll.voters.size;
  const max = Math.max(1, ...[...poll.votes.values()]);
  return (
    <div className="msg msg-poll" data-testid={`poll-${p.ev.getId()}`}>
      <div className="poll-question">📊 {poll.start.question}</div>
      {poll.start.answers.map((a) => {
        const count = poll.votes.get(a.id) ?? 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const mine = poll.myVote.includes(a.id);
        return (
          <button
            key={a.id}
            className={`poll-option${mine ? " mine" : ""}${poll.ended ? " ended" : ""}`}
            disabled={poll.ended}
            aria-label={`Vote: ${a.text}`}
            onClick={() => p.onVote?.(p.ev, a.id)}
          >
            <span className="poll-bar" style={{ width: `${(count / max) * 100}%` }} />
            <span className="poll-label">
              {mine ? "☑" : "☐"} {a.text}
            </span>
            <span className="poll-count">
              {count} · {pct}%
            </span>
          </button>
        );
      })}
      <div className="poll-meta">
        {total} {total === 1 ? "vote" : "votes"}
        {poll.start.maxSelections > 1 && ` · pick up to ${poll.start.maxSelections}`}
        {poll.ended && <span className="poll-ended"> · ended{poll.endedBy ? ` by ${poll.endedBy.split(":")[0]}` : ""}</span>}
        {!poll.ended && p.ev.getSender() === p.myUserId && p.onEndPoll && (
          <button className="poll-end-btn" onClick={() => p.onEndPoll?.(p.ev)} aria-label="End poll">
            End poll
          </button>
        )}
      </div>
    </div>
  );
}

export function kindFor(ev: MatrixEvent): EventKind {
  return kindOf(ev);
}

export function contributions(): TimelineItemContribution[] {
  return [
    { slot: "timeline-item", kind: "text", render: TextLike("text") },
    { slot: "timeline-item", kind: "notice", render: TextLike("notice") },
    { slot: "timeline-item", kind: "emote", render: TextLike("emote") },
    { slot: "timeline-item", kind: "image", render: MediaBody },
    { slot: "timeline-item", kind: "file", render: MediaBody },
    { slot: "timeline-item", kind: "audio", render: MediaBody },
    { slot: "timeline-item", kind: "video", render: MediaBody },
    { slot: "timeline-item", kind: "system", render: SystemBody },
    { slot: "timeline-item", kind: "utd", render: UtdBody },
    { slot: "timeline-item", kind: "redacted", render: RedactedBody },
    { slot: "timeline-item", kind: "reaction", render: () => null },
    { slot: "timeline-item", kind: "poll", render: PollBody },
    { slot: "timeline-item", kind: "unknown", render: UnknownBody },
  ];
}

export const messagesModule: LinnetModule = {
  id: "linnet.messages",
  contributions: () => [...contributions()],
};

/** Exposed for RoomView chrome (not part of the module seam). */
export const _chrome = { aggregateReactions, latestEdits, replyTargetId, QUICK_REACTIONS };

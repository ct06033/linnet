/**
 * linnet.messages — timeline-item renderers registered through the public
 * seam (PRD §6.9 API honesty). RoomView owns layout chrome; these own content
 * bodies per EventKind.
 */
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import type { ReactNode } from "react";
import type { LinnetModule, TimelineItemContribution } from "@linnet/core";
import { sanitizeHtml, mxcUrl } from "./html.js";
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
  type ReactionAgg,
} from "./model.js";

export interface TimelineItemProps {
  ev: MatrixEvent;
  client: MatrixClient;
  myUserId: string | null;
  edited: boolean;
  editContent?: Record<string, unknown>;
  replyTarget?: { senderName: string; body: string } | null;
  reactions: ReactionAgg[];
  onReact: (target: MatrixEvent, key: string) => void;
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
  const url = (content["url"] ?? (content["file"] as Record<string, unknown> | undefined)?.["url"]) as
    | string
    | undefined;
  const body = String(content["body"] ?? "attachment");
  const msgtype = String(content["msgtype"] ?? kindOf(p.ev));
  if (msgtype === "m.image" && url) {
    return (
      <div className="msg msg-image">
        <img
          className="thumb"
          alt={body}
          src={mxcUrl(url, p.client.getHomeserverUrl())}
          data-testid={`img-${p.ev.getId()}`}
        />
        <ReactionRow {...p} />
      </div>
    );
  }
  return (
    <div className="msg msg-file" data-testid={`file-${p.ev.getId()}`}>
      <span className={`file-kind ${msgtype.replace(/[.]/g, "-")}`}>
        {msgtype === "m.audio" ? "🔊" : msgtype === "m.video" ? "🎬" : "📎"}
      </span>
      <span className="file-name">{body}</span>
      <ReactionRow {...p} />
    </div>
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
    { slot: "timeline-item", kind: "unknown", render: UnknownBody },
  ];
}

export const messagesModule: LinnetModule = {
  id: "linnet.messages",
  contributions: () => [...contributions()],
};

/** Exposed for RoomView chrome (not part of the module seam). */
export const _chrome = { aggregateReactions, latestEdits, replyTargetId, QUICK_REACTIONS };

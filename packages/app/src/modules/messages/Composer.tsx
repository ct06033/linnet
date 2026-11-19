/**
 * Composer: markdown+rich toggle, drafts, reply/edit modes, slash commands
 * via the registry seam, mentions with @room guard, typing notice, undo hook,
 * file attach + drag-drop upload.
 */
import { useEffect, useRef, useState } from "react";
import { EventType, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import type { ModuleRegistry, SlashCommandContribution } from "@linnet/core";
import { mdToHtml, expandShortcodes, escapeHtml } from "./markdown.js";
import { canNotifyRoom, detectMentions, displayNameOf } from "./model.js";
import { bodyOf } from "./model.js";

export type ComposerMode =
  | { kind: "send" }
  | { kind: "reply"; ev: MatrixEvent; threadRoot?: string }
  | { kind: "edit"; ev: MatrixEvent; text: string };

export interface ComposerProps {
  client: MatrixClient;
  roomId: string;
  registry: ModuleRegistry | null;
  mode: ComposerMode;
  onModeReset: () => void;
  onAck: (eventId: string) => void;
  myUserId: string | null;
}

/** Per-room drafts survive room switches within the session. */
export const drafts = new Map<string, string>();

let lastTypingAt = 0;
async function noticeTyping(client: MatrixClient, roomId: string): Promise<void> {
  const now = Date.now();
  if (now - lastTypingAt > 1000) {
    lastTypingAt = now;
    try {
      await client.sendTyping(roomId, true, 2000);
    } catch {
      /* non-fatal */
    }
  }
}

export function Composer(props: ComposerProps): JSX.Element {
  const { client, roomId, registry, mode, onModeReset, onAck, myUserId } = props;
  const [value, setValue] = useState(() => drafts.get(roomId) ?? "");
  const [rich, setRich] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setValue(drafts.get(roomId) ?? "");
    areaRef.current?.focus();
  }, [roomId]);

  useEffect(() => {
    if (mode.kind === "edit") {
      setValue(mode.text);
      areaRef.current?.focus();
    }
  }, [mode]);

  function update(v: string): void {
    setValue(v);
    drafts.set(roomId, v);
    if (v.trim()) void noticeTyping(client, roomId);
  }

  async function submit(): Promise<void> {
    const text = value.trim();
    if (!text) return;

    // slash commands through the registry (PRD §6.9)
    const slash = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (slash && mode.kind === "send") {
      const cmd = registry
        ?.list("slash-command")
        .find((c: SlashCommandContribution) => c.command === `/${slash[1]}`);
      if (cmd) {
        update("");
        await cmd.run(slash[2] ?? "", { client, roomId, setDraft: update });
        return;
      }
      // unknown slash command: send as text (Element-compatible)
    }

    const expanded = expandShortcodes(text);
    const htmlBody = rich ? mdToHtml(expanded) : undefined;
    const room = client.getRoom(roomId);
    const mentions = detectMentions(expanded, room, myUserId);
    const allowRoom = mentions.atRoom && canNotifyRoom(client, room, myUserId);

    let body = expanded;
    let formatted = htmlBody ? escapeHtmlFallback(htmlBody) : undefined;
    const inReplyTo =
      mode.kind === "reply"
        ? { event_id: mode.ev.getId() ?? "" }
        : undefined;

    if (mode.kind === "reply" && inReplyTo?.event_id) {
      const parent = room?.findEventById(inReplyTo.event_id);
      const pSender = parent?.getSender() ?? "?";
      const pBody = parent ? bodyOf(parent).slice(0, 400) : "";
      body = `> <${pSender}> ${pBody.replace(/\n/g, "\n> ")}\n\n${expanded}`;
      formatted = `<mx-reply><blockquote><a href="https://matrix.to/#/${inReplyTo.event_id}">In reply to</a> <em>${escapeHtml(pSender)}</em><br/>${escapeHtml(pBody)}</blockquote></mx-reply>${formatted ?? escapeHtml(expanded).replace(/\n/g, "<br/>")}`;
    }

    const content: Record<string, unknown> = {
      msgtype: "m.text",
      body,
    };
    if (formatted) {
      content["format"] = "org.matrix.custom.html";
      content["formatted_body"] = formatted;
    }
    const relationBits: Record<string, unknown> = {};
    if (inReplyTo) relationBits["m.in_reply_to"] = inReplyTo;
    // (thread relation for threaded replies is applied via the sendEvent
    //  threadId overload below — js-sdk owns is_falling_back construction)
    if (mode.kind === "edit") {
      const target = mode.ev;
      const oldBody = bodyOf(target);
      relationBits["rel_type"] = "replace";
      relationBits["event_id"] = target.getId();
      content["body"] = `* ${oldBody} ${expanded}`;
      content["formatted_body"] = `* ${escapeHtml(oldBody)} ${escapeHtml(expanded)}`;
      content["m.new_content"] = {
        msgtype: "m.text",
        body: expanded,
        ...(formatted
          ? { format: "org.matrix.custom.html", formatted_body: formatted }
          : {}),
      };
      if (mentions.userIds.length > 0) {
        (content["m.new_content"] as Record<string, unknown>)["m.mentions"] = {
          user_ids: mentions.userIds,
          ...(allowRoom ? { room: true } : {}),
        };
      }
      onModeReset();
    } else {
      if (mentions.userIds.length > 0 || allowRoom) {
        content["m.mentions"] = {
          user_ids: mentions.userIds,
          ...(allowRoom ? { room: true } : {}),
        };
      }
      onModeReset();
    }
    if (Object.keys(relationBits).length > 0) content["m.relates_to"] = relationBits;

    update("");
    try {
      const threadRoot = mode.kind === "reply" ? mode.threadRoot : undefined;
      const res = threadRoot
        ? await client.sendEvent(roomId, threadRoot, EventType.RoomMessage, content as never)
        : await client.sendEvent(roomId, EventType.RoomMessage, content as never);
      onAck(res.event_id);
    } catch (err) {
      /* pending event carries NOT_SENT status; chrome offers retry/cancel */
      console.warn("linnet: send failed", err);
    }
    try {
      await client.sendTyping(roomId, false, 0);
    } catch {
      /* ignore */
    }
  }

  async function attach(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const up = await client.uploadContent(file);
        const isImage = file.type.startsWith("image/");
        await client.sendEvent(roomId, EventType.RoomMessage, {
          msgtype: isImage ? "m.image" : "m.file",
          body: file.name,
          url: up.content_uri,
          info: { mimetype: file.type, size: file.size },
        } as never);
      } catch {
        /* honest no-op: upload failure leaves no ghost */
      } finally {
        setUploading(null);
      }
    }
  }

  return (
    <footer className="composer" data-testid="composer">
      {mode.kind !== "send" && (
        <div className="mode-banner">
          <span>
            {mode.kind === "reply"
              ? `Replying to ${displayNameOf(client as never, mode.ev.getSender() ?? "?")}`
              : "Editing message"}
          </span>
          <button aria-label="cancel" onClick={onModeReset}>✕</button>
        </div>
      )}
      {uploading && <div className="uploading">uploading {uploading}…</div>}
      <div className="composer-row">
        <textarea
          ref={areaRef}
          aria-label="Message"
          rows={1}
          value={value}
          placeholder="Message"
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape" && mode.kind !== "send") {
              onModeReset();
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length > 0) void attach(e.dataTransfer.files);
          }}
          onDragOver={(e) => e.preventDefault()}
        />
        <div className="composer-buttons">
          <button
            aria-label="toggle formatting"
            className={rich ? "on" : ""}
            onClick={() => setRich((v) => !v)}
            title="Markdown formatting on/off"
          >
            Aa
          </button>
          <label className="attach" title="Attach file">
            📎
            <input
              type="file"
              hidden
              aria-label="Attach file"
              onChange={(e) => e.target.files && void attach(e.target.files)}
            />
          </label>
          <button aria-label="Send message" onClick={() => void submit()} disabled={!value.trim()}>
            Send
          </button>
        </div>
      </div>
    </footer>
  );
}

function escapeHtmlFallback(md: string): string {
  return md; // mdToHtml output is already our own safe HTML subset
}

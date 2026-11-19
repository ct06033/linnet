/**
 * Composer: markdown+rich toggle, drafts, reply/edit modes, slash commands
 * via the registry seam, mentions with @room guard, typing notice, undo hook,
 * file attach + drag-drop upload.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EventType, type MatrixClient, type MatrixEvent } from "matrix-js-sdk";
import type { ModuleRegistry, SlashCommandContribution } from "@linnet/core";
import { mdToHtml, expandShortcodes, escapeHtml } from "./markdown.js";
import { canNotifyRoom, detectMentions, displayNameOf } from "./model.js";
import { bodyOf } from "./model.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { isEncryptedRoom, prepareMediaContent, uploadBytes, uploadPeaks, VoiceRecorder } from "../media/core.js";

export interface PollDraft {
  question: string;
  options: string[];
}

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
  const [pollDraft, setPollDraft] = useState<PollDraft | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // mention autocomplete: trailing @token state
  const mentionQuery = (() => {
    const m = value.match(/(?:^|\s)@([A-Za-z0-9._=\-/]*)$/);
    return m ? m[1]!.toLowerCase() : null;
  })();
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null) return [];
    const room = client.getRoom(roomId);
    const members = Object.values(room?.getJoinedMembers() ?? {});
    return members
      .filter((m) => {
        const local = m.userId.split(":")[0]?.replace(/^@/, "") ?? "";
        return (
          m.userId.toLowerCase().includes(mentionQuery) ||
          local.toLowerCase().includes(mentionQuery) ||
          (m.display_name ?? "").toLowerCase().includes(mentionQuery)
        );
      })
      .filter((m) => m.userId !== myUserId)
      .slice(0, 6);
  }, [mentionQuery, client, roomId, value, myUserId]);

  function pickMention(userId: string): void {
    const local = userId.split(":")[0]?.replace(/^@/, "") ?? userId;
    const disp = displayNameOf(client, userId);
    const label = disp && disp !== local ? disp.replace(/\s+/g, "") : userId;
    const replacement = (label.startsWith("@") ? label : `@${label}`) + " ";
    setValue((v) => {
      const next = v.replace(/(^|\s)@([A-Za-z0-9._=\-/]*)$/, (_m, prefix: string) => `${prefix}${replacement}`);
      drafts.set(roomId, next);
      return next;
    });
    areaRef.current?.focus();
  }

  function insertEmoji(char: string): void {
    setValue((v) => {
      const next = v + char;
      drafts.set(roomId, next);
      return next;
    });
  }

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
      if (slash[1]!.toLowerCase() === "poll") {
        update("");
        setPollDraft({ question: (slash[2] ?? "").trim(), options: ["", ""] });
        return;
      }
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

  async function sendPoll(): Promise<void> {
    if (!pollDraft) return;
    const opts = pollDraft.options.map((o) => o.trim()).filter(Boolean);
    const question = pollDraft.question.trim();
    if (!question || opts.length < 2) return;
    try {
      await client.sendEvent(roomId, "m.poll.start" as never, {
        question: { body: expandShortcodes(question) },
        answers: opts.map((t, i) => ({ id: String(i + 1), body: expandShortcodes(t) })),
        max_selections: 1,
      } as never);
    } catch (err) {
      console.warn("linnet: poll create failed", err);
    }
    setPollDraft(null);
  }

  const [recording, setRecording] = useState<{ ms: number; peaks: number[] } | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);

  async function attach(files: FileList | File[]): Promise<void> {
    const encrypted = isEncryptedRoom(client, roomId);
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        if (encrypted) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const content = await prepareMediaContent(client, bytes, file.name, file.type || "application/octet-stream", true);
          await client.sendEvent(roomId, EventType.RoomMessage, content as never);
        } else {
          const up = await client.uploadContent(file);
          const isImage = file.type.startsWith("image/");
          await client.sendEvent(roomId, EventType.RoomMessage, {
            msgtype: isImage ? "m.image" : "m.file",
            body: file.name,
            url: up.content_uri,
            info: { mimetype: file.type, size: file.size },
          } as never);
        }
      } catch {
        /* honest no-op: upload failure leaves no ghost */
      } finally {
        setUploading(null);
      }
    }
  }

  function startVoice(): void {
    const rec = new VoiceRecorder();
    rec
      .start()
      .then(() => {
        recorderRef.current = rec;
        setRecording({ ms: 0, peaks: [] });
      })
      .catch(() => {
        recorderRef.current = null;
        setRecording(null);
      });
  }

  async function stopVoice(send: boolean): Promise<void> {
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecording(null);
    if (!rec) return;
    if (!send) {
      rec.cancel();
      return;
    }
    const v = await rec.stop();
    setUploading("voice message");
    try {
      const bytes = v.bytes;
      const peaksMxc = await uploadPeaks(client, v.peaks);
      const info: Record<string, unknown> = {
        mimetype: v.mimetype || "audio/webm",
        size: bytes.length,
        json: { url: peaksMxc },
        "org.matrix.msc1767.audio": {
          duration: v.durationMs,
          waveform: v.peaks.map((a) => ({ duration: 100, amplitude: a })),
        },
      };
      if (isEncryptedRoom(client, roomId)) {
        const content = await prepareMediaContent(client, bytes, "voice-message.webm", v.mimetype || "audio/webm", true);
        await client.sendEvent(roomId, EventType.RoomMessage, {
          ...content,
          info,
          "org.matrix.msc3245.voice": {},
        } as never);
      } else {
        const url = await uploadBytes(client, bytes, v.mimetype || "audio/webm");
        await client.sendEvent(roomId, EventType.RoomMessage, {
          msgtype: "m.audio",
          body: "Voice message",
          "org.matrix.msc3245.voice": {},
          info,
          url,
        } as never);
      }
    } finally {
      setUploading(null);
    }
  }

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const rec = recorderRef.current;
      if (rec) setRecording({ ms: rec.elapsedMs(), peaks: rec.livePeaks() });
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording !== null]);

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
      {!recording && VoiceRecorder.supported() && (
        <button className="voice-ready" aria-label="Start voice message" onClick={startVoice} data-testid="voice-start">
          🎤
        </button>
      )}
      {recording && (
        <div className="voice-recording" data-testid="voice-recording">
          <span className="rec-dot">●</span>
          <span className="rec-time">{Math.round(recording.ms / 1000)}s</span>
          <div className="rec-wave">
            {recording.peaks.slice(-40).map((p, i) => (
              <i key={i} style={{ height: `${Math.max(10, (p / 1024) * 100)}%` }} />
            ))}
          </div>
          <button aria-label="Cancel voice message" onClick={() => void stopVoice(false)} data-testid="voice-cancel">✕</button>
          <button aria-label="Send voice message" onClick={() => void stopVoice(true)} data-testid="voice-send">Send</button>
        </div>
      )}
      {pollDraft ? (
        <div className="poll-editor" data-testid="poll-editor">
          <input
            aria-label="Poll question"
            placeholder="Question"
            value={pollDraft.question}
            onChange={(e) => setPollDraft({ ...pollDraft, question: e.target.value })}
          />
          {pollDraft.options.map((opt, i) => (
            <div className="poll-opt-row" key={i}>
              <input
                aria-label={`Poll option ${i + 1}`}
                placeholder={`Option ${i + 1}`}
                value={opt}
                onChange={(e) => {
                  const options = [...pollDraft.options];
                  options[i] = e.target.value;
                  setPollDraft({ ...pollDraft, options });
                }}
              />
              {pollDraft.options.length > 2 && (
                <button
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => setPollDraft({ ...pollDraft, options: pollDraft.options.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="poll-editor-actions">
            <button onClick={() => setPollDraft({ ...pollDraft, options: [...pollDraft.options, ""] })}>
              + Add option
            </button>
            <button
              aria-label="Create poll"
              disabled={!pollDraft.question.trim() || pollDraft.options.filter((o) => o.trim()).length < 2}
              onClick={() => void sendPoll()}
            >
              Create poll
            </button>
            <button aria-label="Cancel poll" onClick={() => setPollDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-row" style={{ position: "relative" }}>
          {mentionOptions.length > 0 && (
            <ul className="mention-menu" role="listbox" aria-label="Mention suggestions" data-testid="mention-menu">
              {mentionOptions.map((m, i) => (
                <li key={m.userId}>
                  <button
                    className={i === mentionIdx ? "active" : ""}
                    role="option"
                    aria-selected={i === mentionIdx}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickMention(m.userId);
                    }}
                  >
                    {displayNameOf(client, m.userId)} <code>{m.userId}</code>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={areaRef}
            aria-label="Message"
            rows={1}
            value={value}
            placeholder="Message"
            onChange={(e) => {
              setMentionIdx(0);
              update(e.target.value);
            }}
            onKeyDown={(e) => {
              if (mentionOptions.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIdx((i) => (i + (e.key === "ArrowDown" ? 1 : mentionOptions.length - 1)) % mentionOptions.length);
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  pickMention(mentionOptions[mentionIdx]!.userId);
                  return;
                }
                if (e.key === "Escape") {
                  return;
                }
              }
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
            <span className="picker-anchor">
              <button
                aria-label="Insert emoji"
                onClick={() => setShowEmoji((v) => !v)}
                title="Emoji"
              >
                😊
              </button>
              {showEmoji && (
                <EmojiPicker label="Emoji picker" onSelect={insertEmoji} onClose={() => setShowEmoji(false)} />
              )}
            </span>
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
      )}
    </footer>
  );
}

function escapeHtmlFallback(md: string): string {
  return md; // mdToHtml output is already our own safe HTML subset
}

/**
 * RoomView: the middle pane orchestrator. Owns the live timeline, scroll
 * policy, pagination, read receipts, typing display, undo-send window, and
 * per-event action chrome. Content bodies render through registry
 * timeline-item contributions (PRD §6.9).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Direction,
  EventType,
  EventStatus,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  type EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomState,
} from "matrix-js-sdk";
import type { ModuleRegistry, TimelineItemContribution } from "@linnet/core";
import {
  aggregatePolls,
  aggregateReactions,
  bodyOf,
  displayNameOf,
  groupEvents,
  isPollChild,
  isThreadReply,
  kindOf,
  latestEdits,
  replyTargetId,
} from "./model.js";
import { Composer, type ComposerMode } from "./Composer.js";
import { ThreadPanel } from "./ThreadPanel.js";
import { Viewer } from "../media/renderers.js";
import { Avatar } from "../ui/avatar.js";
import { PaneGutter, usePanes } from "../settings/panes.js";
import { SecurityBanner, SecuritySheet } from "../security/Security.js";
import { prodAdapter } from "../security/prod.js";
import { RoomSettings } from "../settings/RoomSettings.js";
import { getMonitor } from "../call/call.js";
import type { SecurityStatus } from "../security/state.js";
import type { TimelineItemProps } from "./renderers.js";

export interface RoomViewProps {
  client: MatrixClient;
  roomId: string;
  registry: ModuleRegistry | null;
  undoGraceMs?: number;
}

export function RoomView({ client, roomId, registry, undoGraceMs = 3000 }: RoomViewProps): JSX.Element {
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<ComposerMode>({ kind: "send" });
  const [lastAck, setLastAck] = useState<{ eventId: string; ts: number } | null>(null);
  const [paginating, setPaginating] = useState(false);
  const [joined, setJoined] = useState(true);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [pollBusy, setPollBusy] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [secOpen, setSecOpen] = useState(false);
  const [secStatus, setSecStatus] = useState<SecurityStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callErr, setCallErr] = useState<string | null>(null);
  // W14 item 14: the right panel (thread / room settings) is resizable
  const { startDrag } = usePanes();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottom = useRef(true);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setMode({ kind: "send" });
    setLastAck(null);
    setOpenThread(null);
    const room = client.getRoom(roomId);
    setJoined(!room || room.getMyMembership() === "join");
    const onTimeline = (ev: MatrixEvent, rm: Room | undefined): void => {
      if (rm?.roomId === roomId) {
        void ev;
        bump();
      }
    };
    const onUpdate = (state: RoomState): void => {
      if (state?.roomId === roomId) bump();
    };
    const onTyping = (): void => bump();
    const onEcho = (_event: MatrixEvent, _room: Room | undefined, _data?: unknown): void => bump();
    client.on(RoomEvent.Timeline, onTimeline);
    client.on(RoomStateEvent.Update, onUpdate);
    client.on(RoomMemberEvent.Typing, onTyping);
    client.on(RoomEvent.LocalEchoUpdated, onEcho);
    return () => {
      client.removeListener(RoomEvent.Timeline, onTimeline);
      client.removeListener(RoomStateEvent.Update, onUpdate);
      client.removeListener(RoomMemberEvent.Typing, onTyping);
      client.removeListener(RoomEvent.LocalEchoUpdated, onEcho);
    };
  }, [client, roomId, bump]);

  const room = client.getRoom(roomId);
  const myUserId = client.getUserId();

  const { rawEvents, events, pending } = useMemo(() => {
    // COPY: js-sdk returns internal mutable arrays — same reference forever,
    // which would poison downstream useMemo identity deps (learned the hard way)
    const live = [...(room?.getLiveTimeline().getEvents() ?? [])];
    const pend = [...(room?.getPendingEvents() ?? [])];
    const remote = live.filter((e) => !isAnnotation(e) && !isReplace(e) && !isThreadReply(e) && !isPollChild(e));
    return { rawEvents: live, events: remote, pending: pend };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, tick]);

  const eventsById = useMemo(() => {
    const m = new Map<string, MatrixEvent>();
    for (const e of [...events, ...pending]) if (e.getId()) m.set(e.getId()!, e);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, pending]);

  const edits = useMemo(() => latestEdits([...rawEvents, ...pending]), [rawEvents, pending]);
  const reactions = useMemo(() => aggregateReactions(rawEvents, myUserId), [rawEvents, myUserId]);
  const polls = useMemo(() => aggregatePolls(rawEvents, myUserId), [rawEvents, myUserId]);
  const threadByRoot = useMemo(() => {
    const m = new Map<string, { count: number; lastTs: number; participants: string[] }>();
    for (const t of room?.getThreads() ?? []) {
      const replies = t.events.filter((e) => e.getId() !== t.id);
      const parts = new Set<string>();
      for (const e of replies) if (e.getSender()) parts.add(e.getSender()!);
      m.set(t.id, {
        count: replies.length,
        lastTs: replies.length ? replies[replies.length - 1]!.getTs() : 0,
        participants: [...parts],
      });
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, tick]);
  const groups = useMemo(() => groupEvents([...events, ...pending]), [events, pending]);
  // W14 item 10: date-change label per group (first event's local calendar day)
  const dayBreaks = useMemo(() => {
    const out: (string | null)[] = [];
    let prev: string | null = null;
    for (const g of groups) {
      const ts = g.events[0]?.getTs() ?? 0;
      const key = ts ? new Date(ts).toDateString() : null;
      out.push(key && key !== prev ? dayLabel(ts) : null);
      if (key) prev = key;
    }
    return out;
  }, [groups]);
  // W14 item 11: sender avatar mxc from this room's member state
  const memberAvatar = (uid: string | undefined): string | undefined =>
    uid && room
      ? (room.currentState.getStateEvents(EventType.RoomMember, uid)?.getContent()?.avatar_url as
          | string
          | undefined)
      : undefined;

  // undo window ticker
  useEffect(() => {
    if (!lastAck) return;
    const t = setInterval(() => {
      if (Date.now() - lastAck.ts > undoGraceMs) setLastAck(null);
      else bump();
    }, 500);
    return () => clearInterval(t);
  }, [lastAck, undoGraceMs, bump]);

  // Esc closes the thread panel
  useEffect(() => {
    if (!openThread) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpenThread(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openThread]);

  // W12 item 2: Esc also closes the settings panel and the image viewer
  useEffect(() => {
    if (!settingsOpen && viewer === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (viewer !== null) setViewer(null);
      else if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, viewer]);

  // autoscroll + receipts
  useEffect(() => {
    const el = scrollerRef.current;
    const last = events[events.length - 1];
    if (el && last && pinnedBottom.current) {
      el.scrollTop = el.scrollHeight;
      if (last.getSender() !== myUserId) {
        void client.sendReadReceipt(last).catch(() => undefined);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, roomId]);

  function onScroll(): void {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && !paginating && room?.getLiveTimeline().getPaginationToken(Direction.Backward)) {
      void loadEarlier();
    }
  }

  async function loadEarlier(): Promise<void> {
    if (!room || paginating) return;
    const tl = room.getLiveTimeline();
    if (!tl.getPaginationToken(Direction.Backward)) return;
    setPaginating(true);
    try {
      await client.paginateEventTimeline(tl, { backwards: true });
    } catch {
      /* token exhausted / offline — button stays */
    } finally {
      setPaginating(false);
      bump();
    }
  }

  async function react(target: MatrixEvent, key: string): Promise<void> {
    const tid = target.getId();
    if (!tid) return;
    const mine = rawEvents.find(
      (e) =>
        isAnnotation(e) &&
        e.getSender() === myUserId &&
        ((e.getContent() as Record<string, unknown>)["m.relates_to"] as Record<string, unknown> | undefined)
          ?.[
            "event_id"
        ] === tid &&
        ((): boolean => {
          const r = (e.getContent() as Record<string, unknown>)["m.relates_to"] as Record<string, unknown>;
          return String(r["key"] ?? (e.getContent() as Record<string, unknown>)["value"] ?? "") === key;
        })(),
    );
    try {
      const mid = mine?.getId();
      if (mid) await client.redactEvent(roomId, mid);
      else {
        await client.sendEvent(roomId, EventType.Reaction, {
          "m.relates_to": { rel_type: "annotation", event_id: tid, key },
        } as never);
      }
    } catch (err) {
      console.warn("linnet: reaction failed", err);
    }
    bump();
  }

  // reactions live in the timeline; annotation lookup scans rawEvents

  async function sendVote(target: MatrixEvent, answerId: string): Promise<void> {
    const tid = target.getId();
    if (!tid || pollBusy) return;
    setPollBusy(true);
    try {
      await client.sendEvent(roomId, "m.poll.response" as never, {
        "m.relates_to": { rel_type: "m.reference", event_id: tid },
        answers: [answerId],
      } as never);
    } catch (err) {
      console.warn("linnet: poll vote failed", err);
    } finally {
      setPollBusy(false);
    }
    bump();
  }

  async function endPoll(target: MatrixEvent): Promise<void> {
    const tid = target.getId();
    if (!tid) return;
    try {
      await client.sendEvent(roomId, "m.poll.end" as never, {
        "m.relates_to": { rel_type: "m.reference", event_id: tid },
        question: { body: "Final results" },
        answers: [],
      } as never);
    } catch (err) {
      console.warn("linnet: end poll failed", err);
    }
    bump();
  }

  async function undoLast(): Promise<void> {
    if (!lastAck) return;
    try {
      await client.redactEvent(roomId, lastAck.eventId);
    } catch {
      /* toast lands with W6 */
    }
    setLastAck(null);
  }

  if (!joined && room?.getMyMembership() === "invite") {
    return (
      <main className="roomview">
        <div className="join-banner">
          You were invited to this room.
          <button
            onClick={() => {
              void client.joinRoom(roomId).then(bump).catch(() => undefined);
            }}
          >
            Join
          </button>
        </div>
      </main>
    );
  }

  const topic = room?.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent()?.topic as
    | string
    | undefined;
  const e2ee = room?.hasEncryptionStateEvent() ?? false;
  useEffect(() => {
    if (!e2ee) {
      setSecStatus(null);
      return;
    }
    let dead = false;
    prodAdapter.status(client).then((s) => !dead && setSecStatus(s)).catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [client, e2ee]);

  return (
    <main
      className={`roomview${openThread || settingsOpen ? " panel-open" : ""}`}
      data-testid="roomview"
    >
      <header className="room-header">
        <div className="title">
          <span className="room-name">{room?.name ?? roomId}</span>
          {topic && (
            <span className="room-topic-ghost" title={topic} data-testid="room-topic-ghost">
              {topic}
            </span>
          )}
          <SecurityBanner encrypted={e2ee} status={secStatus} onClick={() => setSecOpen(true)} />
          <button className="settings-gear" aria-label="Room settings" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
          <button
            className="call-btn"
            aria-label="Start voice call"
            onClick={() =>
              void getMonitor(client)
                .place(roomId)
                .catch((err: unknown) => setCallErr(String((err as Error)?.message ?? err)))
            }
          >
            📞
          </button>
          {callErr && (
            <span role="alert" className="call-err">
              {callErr}
            </span>
          )}
        </div>
        <div className="sub">
          <span className="members">{room?.getJoinedMemberCount?.() ?? 0} members</span>
        </div>
      </header>

      <div className="body">
      <div className="col-main">
      <div className="scroller" ref={scrollerRef} onScroll={onScroll}>
        {(() => {
          const token = room?.getLiveTimeline().getPaginationToken(Direction.Backward);
          const tlType: EventTimeline | null = room?.getLiveTimeline() ?? null;
          void tlType;
          return token ? (
            <button className="load-earlier" onClick={() => void loadEarlier()} disabled={paginating}>
              {paginating ? "loading…" : "Load earlier messages"}
            </button>
          ) : null;
        })()}
        {groups.map((g, gi) => (
          <Fragment key={`frag-${g.sender}-${gi}`}>
            {dayBreaks[gi] && (
              <div className="day-break" role="separator" data-testid={`day-${gi}`}>
                <span>{dayBreaks[gi]}</span>
              </div>
            )}
          <div className="group">
            {g.events.map((ev, ei) => {
              const kind = kindOf(ev);
              const firstInGroup = ei === 0 && kind !== "system" && kind !== "redacted";
              const contrib = registry
                ?.list("timeline-item")
                .find((c: TimelineItemContribution) => c.kind === kind);
              const editEv = ev.getId() ? edits.get(ev.getId()!) : undefined;
              const replyTo = replyTargetId(ev);
              const parent = replyTo ? eventsById.get(replyTo) : undefined;
              const openImage = (id: string): void => {
                const imgEvents = groups.flatMap((g) => g.events).filter((e) => kindOf(e) === "image");
                setViewer(imgEvents.findIndex((e) => e.getId() === id));
              };
              const replyTargetMemo = parent
                ? { senderName: shortName(parent.getSender() ?? "?"), body: bodyOf(parent) }
                : null;
              const props: TimelineItemProps = {
                onOpenImage: openImage,
                onOpenSecurity: () => setSecOpen(true),
                ev,
                client,
                myUserId,
                edited: Boolean(editEv),
                editContent: editEv?.getContent()?.["m.new_content"] as Record<string, unknown> | undefined,
                replyTarget: replyTargetMemo,
                reactions: (ev.getId() && reactions.get(ev.getId()!)) || [],
                onReact: (t, k) => void react(t, k),
                poll: (() => {
                  const pid = ev.getId();
                  return pid ? polls.get(pid) : undefined;
                })(),
                onVote: (t, a) => void sendVote(t, a),
                onEndPoll: (t) => void endPoll(t),
              };
              const failed = ev.status === EventStatus.NOT_SENT;
              const sending = ev.status === EventStatus.SENDING || ev.status === EventStatus.QUEUED;
              // W12 item 10: own messages get a distinct accent-derived bubble
              // (.mine) so they are instantly recognisable against others.
              const mine = ev.getSender() === myUserId;
              return (
                <div
                  className={`row${firstInGroup ? " head" : ""}${kind === "system" ? " system" : ""}${mine && kind !== "system" ? " mine" : ""}`}
                  key={ev.getId() ?? `p${gi}${ei}`}
                  data-status={sending ? "sending" : failed ? "failed" : undefined}
                  data-mine={kind === "system" ? undefined : mine ? "true" : "false"}
                >
                  {firstInGroup && (
                    <div className="who">
                      <Avatar
                        client={client}
                        mxc={memberAvatar(ev.getSender())}
                        name={displayNameOf(client, ev.getSender() ?? "?")}
                        size={26}
                      />
                      <strong>{displayNameOf(client, ev.getSender() ?? "?")}</strong>
                    </div>
                  )}
                  <div className="content">
                    {contrib ? (contrib.render(props) as JSX.Element) : <em className="muted">{kind}</em>}
                    {sending && <span className="send-hint">sending…</span>}
                    {failed && (
                      <span className="send-fail">
                        failed{" "}
                        <button
                          aria-label="Retry"
                          onClick={() => {
                            if (room) void client.resendEvent(ev, room).then(bump).catch(() => undefined);
                          }}
                        >
                          Retry
                        </button>
                        <button
                          aria-label="Cancel"
                          onClick={() => {
                            client.cancelPendingEvent(ev);
                            bump();
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    )}
                    {(() => {
                      const eid = ev.getId();
                      const th = eid ? threadByRoot.get(eid) : undefined;
                      if (!th || th.count === 0) return null;
                      return (
                        <button
                          className="thread-badge"
                          data-testid={`thread-badge-${ev.getId()}`}
                          onClick={() => setOpenThread(ev.getId()!)}
                        >
                          💬 {th.count} {th.count === 1 ? "reply" : "replies"}
                          {th.participants.length > 0 && (
                            <span className="who-mini"> · {th.participants.map(shortName).join(", ")}</span>
                          )}
                        </button>
                      );
                    })()}
                    {/* W14 item 9: timestamp bottom-right of EVERY message */}
                    {kind !== "system" && kind !== "redacted" && (
                      <time className="msg-time" dateTime={new Date(ev.getTs()).toISOString()}>
                        {formatTs(ev.getTs())}
                      </time>
                    )}
                  </div>
                  {kind !== "system" && kind !== "redacted" && kind !== "utd" && (
                    <div className="actions" role="toolbar" aria-label="Message actions">
                      <button
                        aria-label="Reply"
                        onClick={() =>
                          setMode(() => {
                            const eid = ev.getId();
                            return {
                              kind: "reply",
                              ev,
                              threadRoot: eid && threadByRoot.has(eid) ? eid : undefined,
                            };
                          })
                        }
                      >
                        ↩
                      </button>
                      {ev.getSender() === myUserId && kind === "text" && (
                        <button
                          aria-label="Edit"
                          onClick={() => {
                            const newText = props.editContent?.["body"] ?? bodyOf(ev);
                            setMode({ kind: "edit", ev, text: String(newText) });
                          }}
                        >
                          ✎
                        </button>
                      )}
                      {ev.getSender() === myUserId && (
                        <button
                          aria-label="Delete"
                          onClick={() => {
                            const id = ev.getId();
                            if (id) void client.redactEvent(roomId, id).then(bump).catch(() => undefined);
                          }}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </Fragment>
        ))}
        {events.length === 0 && pending.length === 0 && (
          <p className="placeholder">This room has no messages yet.</p>
        )}
      </div>

      <div className="typing-line" aria-live="polite">
        {(() => {
          const ids = room
            ? Object.values(room.getJoinedMembers())
                .filter((m) => m.typing && m.userId !== myUserId)
                .map((m) => m.userId)
            : [];
          return ids.length > 0
            ? `${ids.map(shortName).join(", ")} ${ids.length === 1 ? "is" : "are"} typing…`
            : null;
        })()}
      </div>

      {lastAck && Date.now() - lastAck.ts <= undoGraceMs && (
        <div className="undo-bar" data-testid="undo-bar">
          Sent ·{" "}
          <button onClick={() => void undoLast()} aria-label="Undo send">
            Undo
          </button>
        </div>
      )}

      <Composer
        client={client}
        roomId={roomId}
        registry={registry}
        mode={mode}
        onModeReset={() => setMode({ kind: "send" })}
        onAck={(eventId) => setLastAck({ eventId, ts: Date.now() })}
        myUserId={myUserId}
      />
      </div>
      {secOpen && (
        <SecuritySheet client={client} adapter={prodAdapter} onClose={() => setSecOpen(false)} />
      )}
      {(openThread || settingsOpen) && <PaneGutter pane="panel" startDrag={startDrag} label="Resize panel" />}
      {settingsOpen && (
        <RoomSettings client={client} roomId={roomId} onClose={() => setSettingsOpen(false)} />
      )}
      {viewer !== null &&
        (() => {
          const imgEvents = groups.flatMap((g) => g.events).filter((e) => kindOf(e) === "image");
          if (viewer < 0 || viewer >= imgEvents.length) return null;
          return (
            <Viewer
              client={client}
              events={imgEvents}
              index={viewer}
              onClose={() => setViewer(null)}
              onNav={(d) => setViewer((v) => Math.max(0, Math.min(imgEvents.length - 1, (v ?? 0) + d)))}
            />
          );
        })()}
      {openThread && room && (
        <ThreadPanel
          client={client}
          room={room}
          threadId={openThread}
          registry={registry}
          myUserId={myUserId}
          onClose={() => setOpenThread(null)}
        />
      )}
      </div>
    </main>
  );

  // eslint hint: allEvents referenced via closure in react()
  function isAnnotation(ev: MatrixEvent): boolean {
    return ev.getType() === EventType.Reaction || kindOf(ev) === "reaction";
  }
  function isReplace(ev: MatrixEvent): boolean {
    const rel = (ev.getContent() as Record<string, unknown>)["m.relates_to"] as
      | Record<string, unknown>
      | undefined;
    return rel?.["rel_type"] === "replace";
  }
}

function shortName(userId: string): string {
  return userId.split(":")[0]?.replace(/^@/, "") ?? userId;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * W7 — 1:1 voice calls (PRD §6.7 MVP). A thin monitor over js-sdk's WebRTC
 * stack: incoming calls surface through CallEventHandlerEvent.Incoming,
 * outgoing ones we create via client.createCall. The monitor keeps the
 * single "active call" the UI renders (Linnet MVP = one call at a time,
 * like Cinny; Element-style multi-call + call-waiting is P1).
 *
 * js-sdk 45 notes (d.ts-verified): placeVoiceCall() acquires media and the
 * platform invite auto-sends after ICE (no public invite API); reject() takes
 * NO args; hold() is not public — hold UI waits for MSC3077 support.
 */
import { CallErrorCode, CallEvent, CallState } from "matrix-js-sdk/lib/webrtc/call.js";
import { CallEventHandlerEvent } from "matrix-js-sdk/lib/webrtc/callEventHandler.js";
import { type MatrixCall, type MatrixClient } from "matrix-js-sdk";

export interface CallSnapshot {
  call: MatrixCall | null;
  state: CallState | null;
  error: string | null;
  /** W14 item 15: call carries a video track either way (or is a video call) */
  video: boolean;
  /** W14 item 15: screensharing feed active (mine or the peer's) */
  sharing: boolean;
}

export const IDLE: CallSnapshot = { call: null, state: null, error: null, video: false, sharing: false };

export function stateLabel(s: CallState | null): string {
  switch (s) {
    case CallState.Fledgling:
    case CallState.InviteSent:
    case CallState.CreateOffer:
      return "Calling…";
    case CallState.Ringing:
      return "Incoming call";
    case CallState.WaitLocalMedia:
    case CallState.CreateAnswer:
    case CallState.Connecting:
      return "Connecting…";
    case CallState.Connected:
      return "Connected";
    case CallState.Ended:
      return "Call ended";
    default:
      return "";
  }
}

/** Opponent id for a 1:1 room (the other member); null when ambiguous. */
export function peerOf(client: MatrixClient, roomId: string): string | null {
  const room = client.getRoom(roomId);
  const me = client.getUserId();
  const others = (room?.getJoinedMembers() ?? []).filter((m) => m.userId !== me);
  return others.length === 1 ? others[0]!.userId : null;
}

export class CallMonitor {
  private readonly client: MatrixClient;
  private snap: CallSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private attachedCall: MatrixCall | null = null;
  private stateHandler: (() => void) | null = null;

  constructor(client: MatrixClient) {
    this.client = client;
  }

  start(): void {
    this.client.on(CallEventHandlerEvent.Incoming, this.onIncoming);
  }

  stop(): void {
    this.client.removeListener(CallEventHandlerEvent.Incoming, this.onIncoming);
    this.clear();
  }

  getSnapshot(): CallSnapshot {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Outgoing voice OR video call in a 1:1 room. Throws user-readable errors. */
  async place(roomId: string, video = false): Promise<void> {
    if (this.snap.call) throw new Error("already in a call");
    if (!peerOf(this.client, roomId)) throw new Error("need exactly one other member to call");
    const call = this.client.createCall(roomId);
    if (!call) throw new Error("calls unsupported on this device");
    this.track(call);
    try {
      // media + auto-invite after ICE (v45: no element args — streams ride feeds)
      if (video) await call.placeVideoCall();
      else await call.placeVoiceCall();
    } catch (err) {
      this.clear();
      throw err;
    }
  }

  /** W14 item 15: accepting a video invite with video=true upgrades to video. */
  answer(video = false): void {
    const call = this.snap.call;
    if (!call) return;
    void call.answer(true, video).catch(() => undefined);
  }

  /**
   * W14 item 15: start/stop screenshare on the LIVE call (v45
   * setScreensharingEnabled pulls getDisplayMedia itself — Electron exposes
   * sourceId picker later; both sides need SDPStreamMetadata, which every
   * js-sdk 45 client advertises). Throws readable errors (denied/cancelled).
   */
  async toggleScreenshare(): Promise<boolean> {
    const call = this.snap.call;
    if (!call) throw new Error("not in a call");
    const next = await call.setScreensharingEnabled(!call.isScreensharing(), {
      audio: false,
      throwOnFail: true,
    });
    this.refresh();
    return next;
  }

  /** Mute/unmute the outgoing camera. */
  toggleLocalVideo(): boolean | null {
    const call = this.snap.call;
    if (!call) return null;
    const next = !call.isLocalVideoMuted();
    void call.setLocalVideoMuted(next);
    return next;
  }

  /** Incoming while busy — reject politely (P1: call waiting). */
  rejectIncoming(call: MatrixCall): void {
    call.reject();
  }

  hangup(): void {
    this.snap.call?.hangup(CallErrorCode.UserHangup, false);
  }

  toggleMute(): boolean | null {
    const call = this.snap.call;
    if (!call) return null;
    const next = !call.isMicrophoneMuted();
    void call.setMicrophoneMuted(next);
    return next;
  }

  private onIncoming = (call: MatrixCall): void => {
    if (this.snap.call) {
      call.reject();
      return;
    }
    this.track(call);
  };

  /** Recompose the derived snapshot from the live call (feeds may change). */
  private refresh(): void {
    const call = this.attachedCall;
    if (call) this.set({ call, state: call.state, error: this.snap.error, video: hasVideo(call), sharing: call.isScreensharing() });
  }

  private track(call: MatrixCall): void {
    const onState = (): void => {
      this.set({ call, state: call.state, error: null, video: hasVideo(call), sharing: call.isScreensharing() });
      if (call.state === CallState.Ended) {
        // hold the ended-state briefly so the UI can flash "Call ended"
        setTimeout(() => {
          if (this.attachedCall === call) this.clear();
        }, 1500);
      }
    };
    call.on(CallEvent.State, onState);
    // W14 item 15: video/screenshare streams arrive as feed changes mid-call
    call.on(CallEvent.FeedsChanged, onState);
    call.on(CallEvent.Error, (err: unknown) => {
      this.set({ call, state: call.state, error: String((err as Error)?.message ?? err), video: hasVideo(call), sharing: call.isScreensharing() });
    });
    this.attachedCall = call;
    this.stateHandler = onState;
    this.set({ call, state: call.state, error: null, video: hasVideo(call), sharing: call.isScreensharing() });
  }

  private clear(): void {
    if (this.attachedCall && this.stateHandler) {
      this.attachedCall.removeListener(CallEvent.State, this.stateHandler as never);
    }
    this.attachedCall = null;
    this.stateHandler = null;
    this.set(IDLE);
  }

  private set(next: CallSnapshot): void {
    this.snap = next;
    for (const l of this.listeners) l();
  }
}

/** Attach a MediaStream to an <audio> element when the environment allows
 *  (jsdom has no srcObject; Tauri/Electron webviews do). */
export function attachStream(el: HTMLAudioElement | null, stream: MediaStream | null | undefined): void {
  if (!el || !stream) return;
  try {
    (el as unknown as { srcObject: MediaStream | null }).srcObject = stream;
  } catch {
    /* headless test env — nothing to play */
  }
}

/** Any video on the call at all (either direction, including an upgrade). */
function hasVideo(call: MatrixCall): boolean {
  try {
    return (
      call.type === "video" ||
      call.hasLocalUserMediaVideoTrack ||
      call.hasRemoteUserMediaVideoTrack
    );
  } catch {
    return false;
  }
}

/** Singleton per client (App installs one; RoomView places through it). */
const monitors = new WeakMap<MatrixClient, CallMonitor>();
export function getMonitor(client: MatrixClient): CallMonitor {
  let m = monitors.get(client);
  if (!m) {
    m = new CallMonitor(client);
    monitors.set(client, m);
  }
  return m;
}

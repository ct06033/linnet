/**
 * W7 — global call banner: incoming Accept/Decline, in-call controls
 * (mute, hangup), state labels, hidden audio element for remote audio.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { CallState, type MatrixCall } from "matrix-js-sdk/lib/webrtc/call.js";
import { attachStream, getMonitor, stateLabel } from "./call.js";

/** 45 keeps feeds typed loosely across the lib boundary — resolve defensively. */
function remoteStream(call: MatrixCall | null): MediaStream | null {
  const feed = call?.remoteUsermediaFeed as { getStream?: () => MediaStream | undefined } | undefined;
  return feed?.getStream?.() ?? null;
}

export function CallBanner({ client }: { client: MatrixClient | null }): ReactNode {
  const monitor = client ? getMonitor(client) : null;
  const snap = useSyncExternalStore(
    monitor ? (cb) => monitor.subscribe(cb) : () => () => undefined,
    monitor ? () => monitor.getSnapshot() : () => null,
    monitor ? () => monitor.getSnapshot() : () => null,
  );
  const remoteRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!monitor) return;
    monitor.start();
    return () => monitor.stop();
  }, [monitor]);

  useEffect(() => {
    attachStream(remoteRef.current, remoteStream(snap?.call ?? null));
  }, [snap]);

  if (!monitor || !snap?.call) return null;
  const incoming = snap.state === CallState.Ringing;
  const roomName = client?.getRoom(snap.call.roomId)?.name ?? snap.call.roomId.replace(/^!/, "");
  return (
    <div className="call-bar" role="region" aria-label="Call">
      <span className="call-peer">{roomName}</span>
      <span className={`call-state${snap.error ? " error" : ""}`}>{snap.error ?? stateLabel(snap.state)}</span>
      {incoming ? (
        <>
          <button aria-label="Accept call" onClick={() => monitor.answer()}>
            Accept
          </button>
          <button aria-label="Decline call" onClick={() => monitor.hangup()}>
            Decline
          </button>
        </>
      ) : (
        <>
          <button aria-label="Toggle mute" onClick={() => monitor.toggleMute()}>
            Mute
          </button>
          <button aria-label="End call" onClick={() => monitor.hangup()}>
            Hang up
          </button>
        </>
      )}
      <audio ref={remoteRef} autoPlay aria-label="Remote audio" />
    </div>
  );
}

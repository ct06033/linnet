/**
 * W7 — global call banner: incoming Accept/Decline, in-call controls
 * (mute, hangup), state labels, hidden audio element for remote audio.
 * W14 item 15 — video stage (remote usermedia + local PiP + screenshare tile),
 * accept-with-video, camera mute and screenshare toggles.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { CallState, type MatrixCall } from "matrix-js-sdk/lib/webrtc/call.js";
import { attachStream, getMonitor, stateLabel } from "./call.js";

/** 45 keeps feeds typed loosely across the lib boundary — resolve defensively. */
function streamOf(call: MatrixCall | null, getter: string): MediaStream | null {
  if (!call) return null;
  const direct = (call as unknown as Record<string, MediaStream | undefined>)[getter];
  if (direct) return direct;
  const feed = (call as unknown as Record<string, { getStream?: () => MediaStream | undefined } | undefined>)[
    getter.replace("Stream", "Feed")
  ];
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
  const remoteVidRef = useRef<HTMLVideoElement | null>(null);
  const localVidRef = useRef<HTMLVideoElement | null>(null);
  const screenRef = useRef<HTMLVideoElement | null>(null);
  const [shareErr, setShareErr] = useState<string | null>(null);

  useEffect(() => {
    if (!monitor) return;
    monitor.start();
    return () => monitor.stop();
  }, [monitor]);

  const call = snap?.call ?? null;
  useEffect(() => {
    attachStream(remoteRef.current, streamOf(call, "remoteUsermediaStream"));
    attachStream(remoteVidRef.current, streamOf(call, "remoteUsermediaStream"));
    attachStream(localVidRef.current, streamOf(call, "localUsermediaStream"));
    // the big screenshare tile: the opponent's screen wins over my own preview
    attachStream(
      screenRef.current,
      streamOf(call, "remoteScreensharingStream") ?? streamOf(call, "localScreensharingStream"),
    );
  }, [call, snap?.video, snap?.sharing]);

  if (!monitor || !snap?.call) return null;
  const incoming = snap.state === CallState.Ringing;
  const roomName = client?.getRoom(snap.call.roomId)?.name ?? snap.call.roomId.replace(/^!/, "");
  const sharingTile = snap.sharing
    ? streamOf(call, "remoteScreensharingStream") ?? streamOf(call, "localScreensharingStream")
    : null;
  return (
    <>
      {snap.video && (
        <div className="call-stage" data-testid="call-stage" data-sharing={sharingTile ? "true" : undefined}>
          {sharingTile ? (
            <video ref={screenRef} className="call-screen" autoPlay playsInline aria-label="Screenshare" />
          ) : (
            <video ref={remoteVidRef} className="call-remote" autoPlay playsInline aria-label="Remote video" />
          )}
          <video ref={localVidRef} className="call-local" autoPlay playsInline muted aria-label="Your camera" />
        </div>
      )}
      <div className="call-bar" role="region" aria-label="Call">
        <span className="call-peer">{roomName}</span>
        <span className={`call-state${snap.error ? " error" : ""}`}>{snap.error ?? stateLabel(snap.state)}</span>
        {incoming ? (
          <>
            <button aria-label="Accept call" onClick={() => monitor.answer(snap.video)}>
              Accept
            </button>
            <button aria-label="Decline call" onClick={() => monitor.hangup()}>
              Decline
            </button>
          </>
        ) : (
          <>
            {snap.video && (
              <button aria-label="Toggle camera" onClick={() => monitor.toggleLocalVideo()}>
                🎥
              </button>
            )}
            <button
              aria-label={snap.sharing ? "Stop screenshare" : "Start screenshare"}
              aria-pressed={snap.sharing}
              onClick={() => {
                setShareErr(null);
                monitor.toggleScreenshare().catch((err: unknown) =>
                  setShareErr(String((err as Error)?.message ?? "screen share failed")),
                );
              }}
            >
              🖥
            </button>
            <button aria-label="Toggle mute" onClick={() => monitor.toggleMute()}>
              Mute
            </button>
            <button aria-label="End call" onClick={() => monitor.hangup()}>
              Hang up
            </button>
          </>
        )}
        {shareErr && (
          <span role="alert" className="call-err">
            {shareErr}
          </span>
        )}
        <audio ref={remoteRef} autoPlay aria-label="Remote audio" />
      </div>
    </>
  );
}

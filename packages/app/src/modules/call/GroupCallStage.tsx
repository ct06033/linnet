/**
 * W15 phase 2a — the in-app group-call stage: ensure the m.call widget,
 * embed Element Call from the MSC4143 transport origin, drive the widget
 * host, and tombstone the widget on leave.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { ensureCallWidget, removeCallWidget, type ActiveCallWidget } from "./groupcall.js";
import { startWidgetHost } from "./widgetHost.js";

export function GroupCallStage({
  client,
  roomId,
  onClose,
}: {
  client: MatrixClient;
  roomId: string;
  onClose: () => void;
}): ReactNode {
  const [widget, setWidget] = useState<ActiveCallWidget | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let dead = false;
    setWidget(null);
    setErr(null);
    ensureCallWidget(client, roomId)
      .then((w) => {
        if (!dead) setWidget(w);
      })
      .catch((e: unknown) => {
        if (!dead) setErr(String((e as Error)?.message ?? e));
      });
    return () => {
      dead = true;
    };
  }, [client, roomId]);

  useEffect(() => {
    if (!widget || !iframeRef.current) return;
    // W21 item 10: a loaded Element Call starts its widget handshake within
    // seconds. Silence for 15s = the page never loaded (DNS/TLS/unreachable
    // service) — say so instead of showing a blank frame forever.
    const origin = new URL(widget.serviceUrl).origin;
    let armed: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      setErr(
        `Element Call at ${origin} never responded — the call service is unreachable ` +
          "(DNS, TLS certificate, or it isn't running). Group calls need it reachable from this machine.",
      );
    }, 15000);
    const disarm = (): void => {
      if (!armed) return;
      clearTimeout(armed);
      armed = null;
    };
    const host = startWidgetHost({
      client,
      roomId,
      widgetId: widget.id,
      iframe: iframeRef.current,
      origin,
      onActivity: () => {
        disarm();
        setErr((e) => (e && e.startsWith("Element Call at") ? null : e));
      },
    });
    return () => {
      disarm();
      host.stop();
    };
  }, [widget, client, roomId]);

  const leave = (): void => {
    void removeCallWidget(client, roomId).finally(onClose);
  };

  if (err) {
    return (
      <div className="call-stage">
        <header>
          <span className="stage-title">Group call</span>
          <button className="stage-leave" onClick={onClose}>
            Close
          </button>
        </header>
        <p role="alert" className="call-err">
          {err}
        </p>
      </div>
    );
  }
  if (!widget) {
    return (
      <div className="call-stage">
        <p className="placeholder">Connecting group call…</p>
      </div>
    );
  }
  return (
    <div className="call-stage">
      <header>
        <span className="stage-title">Group call</span>
        <button className="stage-leave" aria-label="Leave group call" onClick={leave}>
          Leave
        </button>
      </header>
      <iframe
        ref={iframeRef}
        className="ec-frame"
        title="Element Call"
        src={widget.url}
        allow="camera; microphone; display-capture; autoplay; clipboard-write; fullscreen"
      />
    </div>
  );
}

/**
 * linnet.media timeline renderers: image (auth or A2HS-encrypted), voice
 * message (waveform + play), generic file (save), and the full-size lightbox
 * viewer. Bodies are dumb about chrome — RoomView/renderers.tsx owns rows and
 * reactions.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { rawContentOf } from "../messages/model.js";
import { resolveMediaSrc, fetchPeaks } from "./core.js";
import { downloadEncryptedMedia, downloadMedia } from "./crypt.js";
import { mediaHeaders, tokenOf } from "./core.js";

export interface MediaBodyProps {
  ev: MatrixEvent;
  client: MatrixClient;
  /** effective content (editContent ?? rawContentOf) */
  content: Record<string, unknown>;
  onOpenImage?: (evId: string) => void;
}

function bodyText(content: Record<string, unknown>): string {
  return String(content["body"] ?? "attachment");
}

function infoOf(content: Record<string, unknown>): Record<string, unknown> {
  return (content["info"] as Record<string, unknown>) ?? {};
}

export function ImageBody(props: MediaBodyProps): ReactNode {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let dead = false;
    resolveMediaSrc(props.client, props.content)
      .then((u) => !dead && setSrc(u))
      .catch(() => !dead && setErr(true));
    return () => {
      dead = true;
    };
  }, [props.client, props.content]);
  const body = bodyText(props.content);
  if (err) {
    return (
      <div className="msg msg-file" data-testid={`file-${props.ev.getId()}`}>
        <span className="file-kind image-broken">🖼️</span>
        <span className="file-name">{body} (media unavailable)</span>
      </div>
    );
  }
  if (!src) return <div className="media-loading">{body}</div>;
  return (
    <div className="msg msg-image">
      <img
        className="thumb"
        alt={body}
        src={src}
        data-testid={`img-${props.ev.getId()}`}
        onClick={() => props.onOpenImage?.(props.ev.getId() ?? "")}
      />
    </div>
  );
}

function fmtSeconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceBody(props: MediaBodyProps): ReactNode {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const info = infoOf(props.content);
  const msc1767 = info?.["org.matrix.msc1767.audio"] as { duration?: number; waveform?: { amplitude: number }[] } | undefined;
  const durationMs = msc1767?.duration ?? 0;
  const jsonUrl = info?.["json"] as { url?: string } | undefined;

  useEffect(() => {
    let dead = false;
    const inline = msc1767?.waveform?.map((w) => Math.min(1024, w.amplitude)) ?? null;
    if (inline?.length) {
      setPeaks(inline);
    } else if (jsonUrl?.url) {
      fetchPeaks(props.client, jsonUrl.url)
        .then((p) => !dead && setPeaks(p))
        .catch(() => !dead && setPeaks([]));
    } else {
      setPeaks([]);
    }
    return () => {
      dead = true;
    };
  }, [props.client, jsonUrl?.url, msc1767?.waveform]);

  async function ensureLoaded(): Promise<void> {
    const el = audioRef.current;
    if (!el || el.src) return;
    el.src = await resolveMediaSrc(props.client, props.content);
  }

  async function toggle(): Promise<void> {
    const el = audioRef.current;
    if (!el) return;
    try {
      await ensureLoaded();
      if (playing) {
        el.pause();
        setPlaying(false);
      } else {
        await el.play();
        setPlaying(true);
      }
    } catch {
      setPlaying(false);
    }
  }

  const bars = peaks ?? null;
  return (
    <div className="msg voice-body" data-testid={`voice-${props.ev.getId()}`}>
      <button className="voice-play" aria-label={playing ? "Pause" : "Play"} onClick={() => void toggle()} data-testid={`play-${props.ev.getId()}`}>
        {playing ? "⏸" : "▶"}
      </button>
      <div className="wave" role="slider" aria-label="Seek" aria-valuenow={0} aria-valuemin={0} aria-valuemax={100} onClick={(e) => {
        const el = audioRef.current;
        if (!el || !durationMs) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        try { el.currentTime = ratio * (durationMs / 1000); } catch { /* jsdom */ }
      }}>
        {(bars ?? Array.from({ length: 24 }, () => 300)).map((p, i) => (
          <i key={i} style={{ height: `${Math.max(8, Math.round((p / 1024) * 100))}%` }} />
        ))}
      </div>
      <span className="voice-time" data-testid={`voice-time-${props.ev.getId()}`}>{fmtSeconds(durationMs)}</span>
      <audio ref={audioRef} hidden onEnded={() => setPlaying(false)} data-testid={`audio-${props.ev.getId()}`} />
    </div>
  );
}

export function FileBody(props: MediaBodyProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const info = infoOf(props.content);
  const size = typeof info.size === "number" ? info.size : undefined;
  const kind = String(props.content["msgtype"] ?? "m.file");
  const icon = kind === "m.video" ? "🎬" : "📎";
  async function save(): Promise<void> {
    setBusy(true);
    try {
      const bytes = props.content["file"]
        ? await downloadEncryptedMedia(props.content, fetch, props.client.getHomeserverUrl(), tokenOf(props.client))
        : await downloadMedia(String(props.content["url"]), fetch, props.client.getHomeserverUrl(), tokenOf(props.client));
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: String(info.mimetype ?? "application/octet-stream") }));
      const a = document.createElement("a");
      a.href = url;
      a.download = bodyText(props.content);
      a.click();
    } catch {
      /* honest no-op: save failed, user can retry */
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="msg msg-file" data-testid={`file-${props.ev.getId()}`}>
      <span className={`file-kind ${kind.replace(/[.]/g, "-")}`}>{icon}</span>
      <span className="file-name">{bodyText(props.content)}</span>
      {size != null && <span className="file-size">{size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`}</span>}
      <button className="file-save" disabled={busy} onClick={() => void save()} data-testid={`save-${props.ev.getId()}`}>
        {busy ? "…" : "Save"}
      </button>
    </div>
  );
}

export interface ViewerProps {
  client: MatrixClient;
  events: MatrixEvent[];
  index: number;
  onClose: () => void;
  onNav: (delta: number) => void;
}

export function Viewer({ client, events, index, onClose, onNav }: ViewerProps): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNav(1);
      else if (e.key === "ArrowLeft") onNav(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNav]);
  const ev = events[index];
  if (!ev) return null;
  const content = rawContentOf(ev);
  const body = String(content["body"] ?? "image");
  return (
    <div className="viewer-backdrop" data-testid="viewer" onClick={onClose}>
      <div className="viewer-stage" onClick={(e) => e.stopPropagation()}>
        <MediaFigure client={client} content={content} />
        <div className="viewer-bar">
          <span className="viewer-alt">{body}</span>
          <span className="viewer-count">{index + 1} / {events.length}</span>
          {index > 0 && <button aria-label="Previous image" onClick={() => onNav(-1)} data-testid="viewer-prev">←</button>}
          {index < events.length - 1 && <button aria-label="Next image" onClick={() => onNav(1)} data-testid="viewer-next">→</button>}
          <button aria-label="Close" onClick={onClose} data-testid="viewer-close">✕</button>
        </div>
      </div>
    </div>
  );
}

function MediaFigure({ client, content }: { client: MatrixClient; content: Record<string, unknown> }): ReactNode {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    setSrc(null);
    resolveMediaSrc(client, content).then((u) => !dead && setSrc(u)).catch(() => {});
    return () => {
      dead = true;
    };
  }, [client, content]);
  if (!src) return <div className="viewer-loading">loading…</div>;
  return <img className="viewer-img" src={src} alt={String(content["body"] ?? "")} data-testid="viewer-img" />;
}

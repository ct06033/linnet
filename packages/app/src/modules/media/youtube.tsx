/**
 * W14 item 1 (PRD §8 family: URL previews) — inline YouTube playback.
 * Privacy-respecting facade: nothing loads from youtube-nocookie.com until
 * the user clicks play (the thumbnail comes from i.ytimg.com, the oEmbed
 * alternative would ping Google per rendered message).
 */
import { useState, type ReactNode } from "react";

// watch?v= (with any preceding params), shorts, embed, live, bare youtu.be
const YT_RE =
  /(?:youtube\.com\/(?:watch\?(?:[\w%=&;.-]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;

/** Unique 11-char video ids found in arbitrary text (plain body or HTML). */
export function extractYouTubeIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(YT_RE)) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export interface YouTubeEmbedProps {
  videoId: string;
  title?: string;
}

export function YouTubeEmbed({ videoId, title }: YouTubeEmbedProps): ReactNode {
  const [playing, setPlaying] = useState(false);
  if (playing) {
    return (
      <div className="yt-frame-wrap" data-testid={`yt-frame-${videoId}`}>
        <iframe
          title={title ?? `YouTube video ${videoId}`}
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`}
          allow="accelerometer; encrypted-media; picture-in-picture; clipboard-write; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      className="yt-facade"
      data-testid={`yt-facade-${videoId}`}
      onClick={() => setPlaying(true)}
      aria-label={`Play YouTube video: ${title ?? videoId}`}
    >
      <img
        className="yt-thumb"
        src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`}
        alt=""
        loading="lazy"
      />
      <span className="yt-play" aria-hidden="true">
        ▶
      </span>
      <span className="yt-brand">YouTube</span>
    </button>
  );
}

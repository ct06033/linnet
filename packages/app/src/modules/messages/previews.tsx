/**
 * P1 URL previews (PRD §7 "URL previews (client-fetched OG)").
 *
 * Privacy + architecture: the page HTML is fetched OUT OF the renderer — the
 * Electron main process (window.linnet.fetchUrl bridge) has no CORS and no
 * session cookies of the user, so arbitrary sites can't see auth state. On
 * the web build the bridge is absent and we try a plain fetch; sites without
 * CORS simply get no preview (silent degrade, never an error UI).
 *
 * Everything extracted from foreign HTML is rendered as PLAIN TEXT nodes —
 * no innerHTML, no script execution — and the image is loaded
 * referrerpolicy="no-referrer".
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

export interface OgMeta {
  url: string;
  title?: string;
  description?: string;
  image?: string;
}

export type PreviewFetcher = (url: string) => Promise<string | null>;

let injectedFetcher: PreviewFetcher | null = null;
const cache = new Map<string, OgMeta | null>();

/** Test seam: replace the HTML source entirely. */
export function setPreviewFetcher(f: PreviewFetcher | null): void {
  injectedFetcher = f;
  cache.clear();
}

/** First http(s) URL worth previewing (skip YouTube — that's the embed facade). */
const URL_RE = /https?:\/\/[^\s<>"'()\[\]]+/g;
const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be)$/i;
const FILE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|pdf|zip|mp4|webm|mov|mp3|ogg)([?#]|$)/i;

export function firstPreviewableUrl(body: string): string | null {
  for (const raw of body.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (SKIP_HOSTS.test(host) || FILE_EXT.test(url)) continue;
    return url;
  }
  return null;
}

/** Extract OG metadata from raw HTML. Pure — DOMParser over inert text. */
export function parseOpenGraph(html: string, baseUrl: string): OgMeta | null {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const meta = (sel: string): string | undefined =>
      doc.querySelector(sel)?.getAttribute("content")?.trim() || undefined;
    const title = meta('meta[property="og:title"]') ?? meta('meta[name="twitter:title"]') ?? doc.querySelector("title")?.textContent?.trim();
    const description = meta('meta[property="og:description"]') ?? meta('meta[name="description"]') ?? meta('meta[name="twitter:description"]');
    let image = meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]');
    if (image) {
      try {
        image = new URL(image, baseUrl).toString();
      } catch {
        image = undefined;
      }
    }
    const clean = (x: string | undefined, max: number): string | undefined =>
      x ? x.slice(0, max).trim() || undefined : undefined;
    const t = clean(title, 200);
    const d = clean(description, 400);
    if (!t && !d) return null;
    return { url: baseUrl, ...(t ? { title: t } : {}), ...(d ? { description: d } : {}), ...(image ? { image } : {}) };
  } catch {
    return null;
  }
}

async function defaultFetch(url: string): Promise<string | null> {
  // Electron: main-process fetch (no CORS). Web: best-effort, CORS kills most.
  const bridge = typeof window !== "undefined" ? window.linnet?.fetchUrl : undefined;
  try {
    if (bridge) {
      const r = await bridge(url);
      return r?.ok ? r.html : null;
    }
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    if (!/text\/html|application\/xhtml/.test(res.headers.get("content-type") ?? "")) return null;
    return (await res.text()).slice(0, 400_000);
  } catch {
    return null;
  }
}

/** Cached, deduped HTML fetch. */
export async function getPreview(url: string): Promise<OgMeta | null> {
  if (cache.has(url)) return cache.get(url)!;
  const promise = (async (): Promise<OgMeta | null> => {
    const html = await (injectedFetcher ?? defaultFetch)(url);
    return html ? parseOpenGraph(html, url) : null;
  })();
  const meta = await promise;
  cache.set(url, meta);
  return meta;
}

export function LinkPreview({ body }: { body: string }): JSX.Element | null {
  const url = firstPreviewableUrl(body);
  const [state, setState] = useState<{ done: boolean; meta: OgMeta | null }>({ done: false, meta: null });
  useEffect(() => {
    let dead = false;
    setState({ done: false, meta: null });
    if (!url) return;
    void getPreview(url).then((m) => !dead && setState({ done: true, meta: m }));
    return () => {
      dead = true;
    };
  }, [url]);
  // No URL, still loading, or the page carries no OG/title at all — no card.
  if (!url || !state.done || !state.meta) return null;
  return renderCard(url, state.meta);
}

function renderCard(url: string, meta: OgMeta | null): JSX.Element {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const open = (): void => {
    if (window.linnet?.openExternal) window.linnet.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <a
      className="link-preview"
      data-testid={`link-preview-${host}`}
      onClick={(e) => {
        e.preventDefault();
        open();
      }}
      href={url}
      rel="noopener noreferrer"
      target="_blank"
    >
      {meta?.image && (
        <img className="lp-img" src={meta.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      )}
      <span className="lp-text">
        <span className="lp-title">{meta?.title ?? host}</span>
        {meta?.description && <span className="lp-desc">{meta.description}</span>}
        <span className="lp-host">{host}</span>
      </span>
    </a>
  );
}

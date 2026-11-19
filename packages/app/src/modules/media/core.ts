/**
 * linnet.media core — attachment pipeline for plaintext + encrypted rooms and
 * the voice-message recorder. All network goes through global fetch with the
 * session's bearer token (the fake HS in tests replaces it wholesale; Electron
 * has native fetch). Spec shapes:
 *   encrypted file: content.file = {url,key,iv,hashes,v} (A2HS, crypt.ts)
 *   voice:          m.audio + org.matrix.msc3245.voice marker,
 *                   info["org.matrix.msc1767.audio"] = {duration, waveform},
 *                   Element-compat peaks JSON at info.json.url
 */
import type { MatrixClient } from "matrix-js-sdk";
import { encryptFile, downloadEncryptedMedia, downloadMedia, type EncryptedFileInfo } from "./crypt.js";

export interface MediaClient extends MatrixClient {}

export function mediaHeaders(client: MatrixClient): Record<string, string> {
  const token = (client as unknown as { getAccessToken?: () => string | null }).getAccessToken?.();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** POST bytes to /_matrix/media/v3/upload; returns the mxc:// URI. */
export async function uploadBytes(
  client: MatrixClient,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<string> {
  const res = await fetch(`${client.getHomeserverUrl()}/_matrix/media/v3/upload`, {
    method: "POST",
    headers: { ...mediaHeaders(client), "Content-Type": contentType },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const body = (await res.json()) as { content_uri: string };
  return body.content_uri;
}

export function isEncryptedRoom(client: MatrixClient, roomId: string): boolean {
  const room = client.getRoom(roomId);
  if (!room) return false;
  return room.currentState.getStateEvents("m.room.encryption", "") != null;
}

export interface PreparedContent {
  msgtype: string;
  body: string;
  url?: string;
  file?: Omit<EncryptedFileInfo, "url"> & { url: string };
  info: Record<string, unknown>;
}

/**
 * Build the m.image/m.file/m.audio content for an attachment. Encrypted rooms
 * (and voice messages, which are always treated as files) go through A2HS.
 */
export async function prepareMediaContent(
  client: MatrixClient,
  bytes: Uint8Array,
  name: string,
  mimetype: string,
  encrypted: boolean,
): Promise<PreparedContent> {
  const kind = mimetype.startsWith("image/") ? "m.image" : mimetype.startsWith("audio/") ? "m.audio" : "m.file";
  if (!encrypted) {
    const url = await uploadBytes(client, bytes, mimetype);
    return { msgtype: kind, body: name, url, info: { mimetype, size: bytes.length } };
  }
  const { info, ciphertext } = await encryptFile(bytes);
  const url = await uploadBytes(client, ciphertext, "application/octet-stream");
  return {
    msgtype: kind,
    body: name,
    file: { ...info, url },
    info: { mimetype, size: bytes.length },
  };
}

const blobCache = new Map<string, Promise<string>>();

/** Resolve (and cache) a blob: URL for an image/file content object. */
export function resolveMediaSrc(client: MatrixClient, content: Record<string, unknown>): Promise<string> {
  const enc = content["file"] as EncryptedFileInfo | undefined;
  const key = enc?.url ? `f:${enc.url}:${enc.iv}` : `u:${String(content["url"] ?? "")}`;
  let hit = blobCache.get(key);
  if (!hit) {
    hit = (async () => {
      const bytes = enc
        ? await downloadEncryptedMedia(content, fetch, client.getHomeserverUrl(), tokenOf(client))
        : await downloadMedia(String(content["url"]), fetch, client.getHomeserverUrl(), tokenOf(client));
      const mime = String((content["info"] as Record<string, unknown> | undefined)?.["mimetype"] ?? "application/octet-stream");
      return blobUrl(bytes, mime);
    })();
    blobCache.set(key, hit);
    hit.catch(() => blobCache.delete(key));
  }
  return hit;
}

export function tokenOf(client: MatrixClient): string {
  return (client as unknown as { getAccessToken?: () => string | null }).getAccessToken?.() ?? "none";
}

function blobUrl(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  if (typeof URL.createObjectURL === "function") return URL.createObjectURL(blob);
  // jsdom fallback: deterministic stand-in (tests polyfill createObjectURL)
  return `blob:linnet-${bytes.length}-${mime}`;
}

export function _clearMediaCache(): void {
  blobCache.clear();
}

/** Peaks JSON round-trip (Element-compatible info.json.url). */
export async function uploadPeaks(client: MatrixClient, peaks: number[]): Promise<string> {
  return uploadBytes(client, new TextEncoder().encode(JSON.stringify({ peaks })), "application/json");
}

export async function fetchPeaks(client: MatrixClient, mxc: string): Promise<number[]> {
  const bytes = await downloadMedia(mxc, fetch, client.getHomeserverUrl(), tokenOf(client));
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { peaks?: number[] };
  return Array.isArray(parsed.peaks) ? parsed.peaks : [];
}

// ---------------------------------------------------------------------------
// Voice recording. Dependencies are injectable so jsdom tests can drive it.

export interface RecorderDeps {
  mediaDevices?: MediaDevices;
  MediaRecorder?: typeof MediaRecorder;
  AudioContext?: typeof AudioContext;
}

/** Blob -> bytes with jsdom fallbacks (jsdom Blob predates .arrayBuffer). */
export async function blobToBytes(b: Blob): Promise<Uint8Array> {
  const anyB = b as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof anyB.arrayBuffer === "function") return new Uint8Array(await anyB.arrayBuffer());
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error ?? new Error("FileReader failed"));
    fr.readAsArrayBuffer(b);
  });
}

export interface VoiceRecording {
  blob: Blob;
  bytes: Uint8Array;
  mimetype: string;
  durationMs: number;
  peaks: number[]; // MSC1767 ints 0..1024
}

export class VoiceRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private peaks: number[] = [];
  private started = 0;
  private analyserTick: ReturnType<typeof setInterval> | null = null;
  private ctx: AudioContext | null = null;

  constructor(private deps: RecorderDeps = {}) {}

  static supported(): boolean {
    const md = (globalThis.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined)?.mediaDevices;
    return Boolean(md?.getUserMedia && (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder);
  }

  private static pickMime(): string {
    const MR = globalThis.MediaRecorder;
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (const c of candidates) {
      try {
        if (MR?.isTypeSupported?.(c)) return c;
      } catch {
        /* keep probing */
      }
    }
    return "audio/webm";
  }

  async start(): Promise<void> {
    const devices = (this.deps.mediaDevices ?? globalThis.navigator?.mediaDevices) as
      | { getUserMedia?: (c: unknown) => Promise<MediaStream> }
      | undefined;
    const MR = this.deps.MediaRecorder ?? globalThis.MediaRecorder;
    if (!devices?.getUserMedia || !MR) throw new Error("voice recording unsupported");
    this.stream = await devices.getUserMedia({ audio: true });
    const mimetype = VoiceRecorder.pickMime();
    this.rec = new MR(this.stream, { mimeType: mimetype });
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.start(100);
    this.started = Date.now();
    this.startPeaks();
  }

  private startPeaks(): void {
    try {
      const AC = this.deps.AudioContext ?? globalThis.AudioContext;
      if (!AC || !this.stream) return;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      this.analyserTick = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const d = (v - 128) / 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / buf.length);
        this.peaks.push(Math.min(1024, Math.round(rms * 4096)));
      }, 100);
    } catch {
      /* peaks are decorative; recording must not die with them */
    }
  }

  elapsedMs(): number {
    return this.started ? Date.now() - this.started : 0;
  }

  livePeaks(): number[] {
    return [...this.peaks];
  }

  async stop(): Promise<VoiceRecording> {
    const mimetype = this.rec?.mimeType ?? "audio/webm";
    const done = new Promise<Blob>((resolve) => {
      if (!this.rec) return resolve(new Blob(this.chunks, { type: mimetype }));
      this.rec.onstop = () => resolve(new Blob(this.chunks, { type: mimetype }));
    });
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    if (this.analyserTick) clearInterval(this.analyserTick);
    void this.ctx?.close?.();
    this.stream?.getTracks().forEach((t) => t.stop?.());
    const blob = await done;
    const bytes = await blobToBytes(blob);
    const durationMs = Date.now() - this.started;
    return { blob, bytes, mimetype, durationMs, peaks: [...this.peaks] };
  }

  cancel(): void {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    if (this.analyserTick) clearInterval(this.analyserTick);
    this.stream?.getTracks().forEach((t) => t.stop?.());
    this.chunks = [];
    this.peaks = [];
  }
}



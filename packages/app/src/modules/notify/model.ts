/**
 * W6 — notification rules (PRD §6.6 MVP), pure and unit-testable.
 * Preferences live in ONE global account_data event (cross-device sync for
 * free; the fake HS stores + echoes it). Modes are per-room like Element's
 * bell toggle; "mentions" still pings DMs (Element default behaviour).
 */
import type { MatrixClient } from "matrix-js-sdk";

export type NotifyMode = "all" | "mentions" | "mute";

export const PREFS_KEY = "im.linnet.notifications";

export interface NotifyPrefs {
  modes: Record<string, NotifyMode>;
  keywords: string[];
}

export const DEFAULT_PREFS: NotifyPrefs = { modes: {}, keywords: [] };

export function readPrefs(client: MatrixClient): NotifyPrefs {
  const raw = client.getAccountData(PREFS_KEY as never)?.getContent() as
    | { modes?: Record<string, NotifyMode>; keywords?: string[] }
    | undefined;
  return { modes: raw?.modes ?? {}, keywords: Array.isArray(raw?.keywords) ? raw.keywords : [] };
}

export async function writePrefs(client: MatrixClient, prefs: NotifyPrefs): Promise<void> {
  await client.setAccountData(PREFS_KEY as never, {
    modes: prefs.modes,
    keywords: prefs.keywords,
  } as never);
}

export async function setRoomMode(client: MatrixClient, roomId: string, mode: NotifyMode): Promise<void> {
  const prefs = readPrefs(client);
  const modes = { ...prefs.modes };
  if (mode === "all") delete modes[roomId];
  else modes[roomId] = mode;
  await writePrefs(client, { ...prefs, modes });
}

/** What the engine hands the rules function, resolved from a MatrixEvent. */
export interface Candidate {
  roomId: string;
  roomName: string;
  isDM: boolean;
  sender: string;
  body: string;
  own: boolean;
  edit: boolean;
  redacted: boolean;
  mentionsYou: boolean;
  mentionsRoom: boolean;
}

export function modeFor(prefs: NotifyPrefs, roomId: string): NotifyMode {
  return prefs.modes[roomId] ?? "all";
}

export function keywordHit(prefs: NotifyPrefs, body: string): boolean {
  const lower = body.toLowerCase();
  return prefs.keywords.some((k) => k.trim() !== "" && lower.includes(k.trim().toLowerCase()));
}

/** N1–N5 decision core. mute suppresses everything (incl. mentions) — the
 *  user explicitly silenced this room. */
export function shouldNotify(c: Candidate, prefs: NotifyPrefs): boolean {
  if (c.own || c.redacted || c.edit) return false;
  const mode = modeFor(prefs, c.roomId);
  if (mode === "mute") return false;
  const ping = c.mentionsYou || c.mentionsRoom || keywordHit(prefs, c.body);
  if (mode === "mentions") return ping || c.isDM;
  return true; // "all"
}

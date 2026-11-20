/**
 * P1 moderation (PRD: "report content, ignore user"). Both are plain spec
 * surface: m.ignored_user_list account data via js-sdk helpers, and
 * POST /rooms/{}/report/{event} (score -100 = Element's "spam" default).
 */
import type { MatrixClient } from "matrix-js-sdk";

export function isIgnored(client: MatrixClient, userId: string | undefined | null): boolean {
  return !!userId && client.getIgnoredUsers().includes(userId);
}

export async function setIgnore(client: MatrixClient, userId: string, ignore: boolean): Promise<void> {
  const cur = new Set(client.getIgnoredUsers());
  if (ignore) cur.add(userId);
  else cur.delete(userId);
  await client.setIgnoredUsers([...cur]);
}

export async function reportMessage(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  reason: string,
): Promise<void> {
  await client.reportEvent(roomId, eventId, -100, reason);
}

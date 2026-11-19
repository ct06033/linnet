/**
 * W5b — client-side space actions over js-sdk 45 (verified against
 * node_modules/matrix-js-sdk/lib/client.d.ts):
 * - client.createRoom(Partial<ICreateRoomOpts>) exists; client.createSpace does
 *   NOT (that is an Element helper) → creation_content.type = "m.space".
 * - sendStateEvent is typed <K extends keyof StateEvents> with ENUM keys →
 *   use EventType.SpaceChild (raw string literals do not satisfy the generic).
 * - state sends go through PUT /rooms/{id}/state/{type}/{stateKey}
 *   (client.js line ~5589), NOT /send/ — the fake HS routes accordingly.
 * - leave/forget: client.leave(roomId) / client.forget(roomId).
 */
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { Preset, Visibility } from "matrix-js-sdk/lib/@types/partials.js";

export const SPACE_CHILD = EventType.SpaceChild;

export async function createSpace(
  client: MatrixClient,
  opts: { name: string; isPublic: boolean; topic?: string },
): Promise<string> {
  const res = await client.createRoom({
    name: opts.name,
    ...(opts.topic ? { topic: opts.topic } : {}),
    visibility: opts.isPublic ? Visibility.Public : Visibility.Private,
    preset: opts.isPublic ? Preset.PublicChat : Preset.PrivateChat,
    creation_content: { type: "m.space" },
  });
  return res.room_id;
}

/** Our homeserver name — m.space.child content.via (required for an ACTIVE
 *  link; empty/absent via means the child was removed). */
export function spaceVia(client: MatrixClient): string[] {
  return [client.getDomain() ?? "localhost"];
}

export async function addRoomToSpace(
  client: MatrixClient,
  spaceId: string,
  roomId: string,
  order?: string,
): Promise<void> {
  await client.sendStateEvent(
    spaceId,
    SPACE_CHILD,
    { via: spaceVia(client), ...(order ? { order } : {}) } as never,
    roomId,
  );
}

export async function removeRoomFromSpace(client: MatrixClient, spaceId: string, roomId: string): Promise<void> {
  // empty content => via missing => link removed (spec-reprised child)
  await client.sendStateEvent(spaceId, SPACE_CHILD, {} as never, roomId);
}

/** S6 + R6 — leave, optionally forget (drop from server memory + local store). */
export async function leaveAndMaybeForget(client: MatrixClient, roomId: string, forget: boolean): Promise<void> {
  await client.leave(roomId);
  if (forget) await client.forget(roomId);
}

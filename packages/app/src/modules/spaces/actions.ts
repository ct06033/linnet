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

/** W12a: the one and only Megolm algorithm we create rooms with. */
export const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

export async function createSpace(
  client: MatrixClient,
  opts: { name: string; isPublic: boolean; topic?: string; encrypt?: boolean },
): Promise<string> {
  // W12a E2EE-default: every new space starts encrypted UNLESS the user
  // explicitly opts out (encrypt:false). Public rooms are the one forced
  // exception — Megolm key distribution into a world-readable room is
  // meaningless (and Element enforces the same ban) — so public implies off.
  const encrypt = opts.encrypt !== false && !opts.isPublic;
  const res = await client.createRoom({
    name: opts.name,
    ...(opts.topic ? { topic: opts.topic } : {}),
    visibility: opts.isPublic ? Visibility.Public : Visibility.Private,
    preset: opts.isPublic ? Preset.PublicChat : Preset.PrivateChat,
    creation_content: { type: "m.space" },
    ...(encrypt
      ? {
          initial_state: [
            { type: "m.room.encryption", state_key: "", content: { algorithm: MEGOLM_ALGORITHM } },
          ],
        }
      : {}),
  });
  return res.room_id;
}

/** W12 item 12: plain-room creation twin of createSpace (same dialog shape,
 *  no m.space marker). W12 item 7 parity: encrypted BY DEFAULT (w12-core rule —
 *  opting out is the explicit action; public forces the opt-out). */
export async function createRoom(
  client: MatrixClient,
  opts: { name: string; isPublic: boolean; encrypt?: boolean },
): Promise<string> {
  const encrypt = opts.encrypt !== false && !opts.isPublic;
  const res = await client.createRoom({
    name: opts.name,
    visibility: opts.isPublic ? Visibility.Public : Visibility.Private,
    preset: opts.isPublic ? Preset.PublicChat : Preset.PrivateChat,
    ...(encrypt
      ? {
          initial_state: [
            { type: "m.room.encryption", state_key: "", content: { algorithm: MEGOLM_ALGORITHM } },
          ],
        }
      : {}),
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

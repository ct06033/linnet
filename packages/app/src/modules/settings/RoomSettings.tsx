/**
 * W5b — room settings panel for the active room, contributed through the
 * registry `panel-tab` slot (PRD §6.9: first-party features use the same
 * seam as modules). Inputs are disabled when maySendStateEvent says the user
 * cannot send the state type (R7 — mirrors Element; the server enforces too).
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import type { LinnetModule } from "@linnet/core";
import { uploadBytes } from "../media/core.js";
import { LockMark } from "../security/Security.js";
import { PresenceDot } from "../ui/presence.js";
import { modeFor, readPrefs, setRoomMode, writePrefs, type NotifyMode } from "../notify/model.js";

export interface RoomSettingsProps {
  client: MatrixClient;
  roomId: string;
  onClose: () => void;
}

const AVATAR = EventType.RoomAvatar;

function topicOf(room: Room | null): string {
  const ev = room?.currentState.getStateEvents(EventType.RoomTopic, "");
  return String(ev?.getContent()["topic"] ?? "");
}
function nameOf(room: Room | null): string {
  const ev = room?.currentState.getStateEvents(EventType.RoomName, "");
  return String(ev?.getContent()["name"] ?? room?.name ?? "");
}
function avatarOf(room: Room | null): string {
  const ev = room?.currentState.getStateEvents(AVATAR, "");
  return String(ev?.getContent()["url"] ?? "");
}

export function RoomSettings({ client, roomId, onClose }: RoomSettingsProps): ReactNode {
  const room = client.getRoom(roomId);
  const me = client.getUserId() ?? "";
  const [nameDraft, setNameDraft] = useState(nameOf(room));
  const [topicDraft, setTopicDraft] = useState(topicOf(room));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forget, setForget] = useState(false);
  const [left, setLeft] = useState(false);
  const [mode, setMode] = useState<NotifyMode>(() => modeFor(readPrefs(client), roomId));
  const [kwDraft, setKwDraft] = useState(() => readPrefs(client).keywords.join(", "));
  // W14-VISIBILITY: encryption state + enable flow (one-way: m.room.encryption
  // cannot be undone once set — hence the inline confirm step)
  const [enc, setEnc] = useState<boolean>(() => room?.hasEncryptionStateEvent() ?? false);
  const [encConfirm, setEncConfirm] = useState(false);

  const can = (type: EventType | string): boolean => room?.currentState.maySendStateEvent(type, me) ?? false;
  const canName = can(EventType.RoomName);
  const canTopic = can(EventType.RoomTopic);
  const canAvatar = can(AVATAR);

  const members = useMemo(() => {
    const joined: string[] = [];
    const invited: string[] = [];
    let invitedYou = false;
    const evs: MatrixEvent[] = room?.currentState.getStateEvents(EventType.RoomMember) ?? [];
    for (const e of evs) {
      const membership = String((e.getContent() as Record<string, unknown>)["membership"] ?? "");
      const uid = e.getStateKey() ?? "";
      if (!uid || uid.startsWith("@") === false) continue;
      if (membership === "join") joined.push(uid);
      else if (membership === "invite") {
        if (uid === me) invitedYou = true;
        else invited.push(uid);
      }
    }
    return { joined: joined.sort(), invited: invited.sort(), invitedYou };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, client]);

  async function act(fn: () => Promise<unknown>, what: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(`${what} failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatarFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const url = await uploadBytes(client, bytes, file.type || "image/png");
    await client.sendStateEvent(roomId, AVATAR, { url, info: { mimetype: file.type || "image/png" } }, "");
  }

  return (
    <div className="room-settings" role="region" aria-label={`Room settings for ${nameOf(room)}`}>
      <div className="settings-head">
        <strong>Room settings</strong>
        <button aria-label="Close room settings" onClick={onClose}>
          ✕
        </button>
      </div>

      {error && <p role="alert">{error}</p>}

      <fieldset disabled={busy}>
        <label>
          Name
          <input
            aria-label="Room name"
            value={nameDraft}
            disabled={!canName || busy}
            onChange={(e) => setNameDraft(e.target.value)}
          />
        </label>
        <button
          aria-label="Save name"
          disabled={!canName || busy || nameDraft === nameOf(room)}
          onClick={() => void act(() => client.sendStateEvent(roomId, EventType.RoomName, { name: nameDraft }, ""), "rename")}
        >
          Save name
        </button>

        <label>
          Topic
          <input
            aria-label="Room topic"
            value={topicDraft}
            disabled={!canTopic || busy}
            onChange={(e) => setTopicDraft(e.target.value)}
          />
        </label>
        <button
          aria-label="Save topic"
          disabled={!canTopic || busy || topicDraft === topicOf(room)}
          onClick={() => void act(() => client.sendStateEvent(roomId, EventType.RoomTopic, { topic: topicDraft }, ""), "topic")}
        >
          Save topic
        </button>

        <div className="avatar-row">
          <span>Avatar {avatarOf(room) ? `(${avatarOf(room)})` : "(none)"}</span>
          <input
            type="file"
            aria-label="Room avatar file"
            accept="image/*"
            disabled={!canAvatar || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void act(() => uploadAvatarFile(f), "avatar upload");
            }}
          />
          <button
            aria-label="Remove avatar"
            disabled={!canAvatar || busy || !avatarOf(room)}
            onClick={() => void act(() => client.sendStateEvent(roomId, AVATAR, {}, ""), "avatar remove")}
          >
            Remove avatar
          </button>
        </div>
      </fieldset>

      <section aria-label="Members">
        <h4>Joined ({members.joined.length})</h4>
        <ul>
          {members.joined.map((uid) => (
            <li key={uid} className="member joined">
              <PresenceDot client={client} userId={uid} />
              {uid}
              {uid === me ? " (you)" : ""}
            </li>
          ))}
          {members.joined.length === 0 && <li className="empty">no joined members</li>}
        </ul>
        <h4>Invited ({members.invited.length})</h4>
        <ul>
          {members.invited.map((uid) => (
            <li key={uid} className="member invited">
              {uid}
            </li>
          ))}
          {members.invited.length === 0 && <li className="empty">no pending invites</li>}
        </ul>
        {members.invitedYou && <p className="member invited-you">invited-you</p>}
      </section>

      <section className="notify-zone" aria-label="Notifications">
        <label>
          Notifications
          <select
            aria-label="Room notification mode"
            value={mode}
            disabled={busy}
            onChange={(e) => {
              const m = e.target.value as NotifyMode;
              setMode(m);
              void act(() => setRoomMode(client, roomId, m), "notification mode");
            }}
          >
            <option value="all">All messages</option>
            <option value="mentions">Mentions only</option>
            <option value="mute">Nothing (mute)</option>
          </select>
        </label>
        <label>
          Keywords (global, comma-separated)
          <input
            aria-label="Notify keywords"
            value={kwDraft}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              setKwDraft(v);
              const keywords = v.split(",").map((k) => k.trim()).filter(Boolean);
              void act(() => writePrefs(client, { ...readPrefs(client), keywords }), "keywords");
            }}
          />
        </label>
      </section>

      <section className="enc-zone" aria-label="Encryption" data-testid="enc-section">
        <h4>Encryption</h4>
        <p className={`enc-state ${enc ? "on" : "off"}`}>
          <LockMark e2ee={enc} /> {enc ? "Encrypted (Megolm)" : "Not encrypted"}
        </p>
        {!enc && can(EventType.RoomEncryption) && !encConfirm && (
          <button className="primary" data-testid="enc-enable" disabled={busy} onClick={() => setEncConfirm(true)}>
            Enable encryption
          </button>
        )}
        {!enc && can(EventType.RoomEncryption) && encConfirm && (
          <div className="enc-confirm" data-testid="enc-confirm">
            <p>Encryption cannot be undone. Enable?</p>
            <button
              className="danger"
              data-testid="enc-enable-confirm"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await client.sendStateEvent(roomId, EventType.RoomEncryption, { algorithm: "m.megolm.v1.aes-sha2" }, "");
                  setEnc(true);
                  setEncConfirm(false);
                }, "enable encryption")
              }
            >
              Enable
            </button>
            <button data-testid="enc-enable-cancel" onClick={() => setEncConfirm(false)}>
              Cancel
            </button>
          </div>
        )}
      </section>

      <section className="danger-zone">
        <label>
          <input
            type="checkbox"
            aria-label="Also forget this room"
            checked={forget}
            onChange={(e) => setForget(e.target.checked)}
          />
          Also forget this room
        </label>
        <button
          className="danger"
          aria-label="Leave room"
          disabled={busy || left}
          onClick={() =>
            void act(async () => {
              await client.leave(roomId);
              if (forget) await client.forget(roomId);
              setLeft(true);
              onClose();
            }, "leave")
          }
        >
          Leave room
        </button>
      </section>
    </div>
  );
}

/** Registry contribution: the settings tab is a first-party panel-tab. */
export const roomSettingsModule: LinnetModule = {
  id: "linnet.room-settings",
  contributions: () => [
    {
      slot: "panel-tab",
      id: "room-settings",
      label: "Room settings",
      render: (props: unknown) => <RoomSettings {...(props as RoomSettingsProps)} />,
    },
  ],
};

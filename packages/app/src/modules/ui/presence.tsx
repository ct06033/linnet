/**
 * P1 presence — presence dot + label for one user, live-updating.
 * js-sdk feeds User objects from /sync presence events and E2E pings;
 * we listen to UserEvent.Presence and re-render, with a 30s clock tick so
 * "last seen" ages stay honest between updates.
 */
import { useEffect, useState } from "react";
import { UserEvent, type MatrixClient } from "matrix-js-sdk";

export type DotPresence = "online" | "unavailable" | "offline" | "unknown";

export function presenceOf(client: MatrixClient, userId: string | undefined): {
  state: DotPresence;
  label: string;
} {
  const u = userId ? client.getUser(userId) : undefined;
  const p = u?.presence as DotPresence | undefined;
  const state = p === "online" || p === "unavailable" || p === "offline" ? p : "unknown";
  const msg = (u as unknown as { presenceStatusMsg?: string } | undefined)?.presenceStatusMsg;
  let label: string;
  if (state === "online") label = u?.currentlyActive ? "Online" : "Idle";
  else if (state === "unavailable") label = "Away";
  else if (state === "offline") label = u?.lastActiveAgo ? `Last seen ${ago(u.lastActiveAgo)}` : "Offline";
  else label = "Presence unknown";
  if (msg) label = `${label} · ${msg}`;
  return { state, label };
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function PresenceDot({ client, userId }: { client: MatrixClient; userId: string | undefined }): JSX.Element | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const onPresence = (): void => setTick((t) => t + 1);
    client.on(UserEvent.Presence, onPresence);
    const iv = setInterval(onPresence, 30_000);
    return () => {
      client.removeListener(UserEvent.Presence, onPresence);
      clearInterval(iv);
    };
  }, [client]);
  if (!userId) return null;
  const { state, label } = presenceOf(client, userId);
  // Element-parity: no presence data at all (HS presence disabled, unknown
  // user) renders NOTHING — grey dots everywhere is noise, not information.
  if (state === "unknown") return null;
  return (
    <span
      className={`p-dot p-${state}`}
      data-testid={`presence-${state}`}
      data-user={userId}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

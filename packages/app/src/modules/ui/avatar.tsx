/**
 * W14 item 11 — shared avatar. Renders the authenticated-media thumbnail of a
 * Matrix mxc URI when one exists, else the accent initials tile every row in
 * the app already uses. Room list rows, the room header, timeline messages,
 * DM rows and the account chip all go through this so faces stay consistent.
 */
import { useState, type ReactNode } from "react";
import type { MatrixClient } from "matrix-js-sdk";

export interface AvatarProps {
  client: MatrixClient | null | undefined;
  /** raw mxc:// URI (from RoomSummary.avatarUrl or an event content) */
  mxc?: string | null;
  /** fallback label + source of initials */
  name: string;
  size?: number;
  className?: string;
}

export function initialsOf(name: string): string {
  const clean = name.replace(/^[#@]/, "");
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0] + parts[1]![0]).toUpperCase();
  return (parts[0]?.[0] ?? clean[0] ?? "?").toUpperCase();
}

export function Avatar({ client, mxc, name, size = 26, className = "" }: AvatarProps): ReactNode {
  const [failed, setFailed] = useState(false);
  // useAuthentication=true (arg 6): Synapse >=1.131 requires auth on media;
  // mxcUrlToHttp then returns the /v1/media URL with ?access_token attached,
  // which MSC3916 explicitly allows for <img> loads that can't set headers.
  const http =
    mxc && client && !failed
      ? client.mxcUrlToHttp(mxc, size * 2, size * 2, "crop", false, false, true)
      : null;
  if (http) {
    return (
      <img
        className={`avatar avatar-img ${className}`}
        src={http}
        width={size}
        height={size}
        loading="lazy"
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className={`avatar ${className}`}
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {initialsOf(name)}
    </span>
  );
}

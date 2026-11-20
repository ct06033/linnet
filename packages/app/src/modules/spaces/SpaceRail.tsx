/**
 * W5b — real spaces rail (replaces the wave-2 scaffold). Home is always the
 * first stop; spaces are name-sorted; DMs never appear (tree.ts owns the
 * filtering rules — this component only renders what it's handed).
 *
 * W12 item 6: rail buttons show the FULL space name (wrapping) beside the
 * initials icon — abbreviations are gone. W12 item 12: the "+ New space"
 * affordance moved into the unified bottom-of-rail Add control (App.tsx +
 * modules/dialogs.tsx), so this rail is pure selection chrome now.
 */
import type { ReactNode } from "react";
import type { RoomSummary } from "@linnet/core";

export interface SpaceRailProps {
  spaces: RoomSummary[];
  /** null = Home */
  active: string | null;
  onSelect: (spaceId: string | null) => void;
}

/** W12 item 6: two letters remain as the ICON — never as the label itself. */
export function spaceInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "S"
  );
}

export function SpaceRail({ spaces, active, onSelect }: SpaceRailProps): ReactNode {
  return (
    <>
      {/* W14 item 3: Home must READ as a button — icon, border, own block */}
      <button
        className={`space home${active === null ? " active" : ""}`}
        aria-label="Home"
        aria-current={active === null ? "page" : undefined}
        onClick={() => onSelect(null)}
      >
        <span className="home-ico" aria-hidden="true">
          ⌂
        </span>
        <span className="space-name">Home</span>
      </button>
      {spaces.map((s) => (
        <button
          key={s.roomId}
          className={`space has-name${active === s.roomId ? " active" : ""}`}
          aria-label={`Space ${s.name}`}
          onClick={() => onSelect(s.roomId)}
        >
          <span className="space-ico" aria-hidden="true">
            {spaceInitials(s.name)}
          </span>
          <span className="space-name">{s.name}</span>
        </button>
      ))}
    </>
  );
}

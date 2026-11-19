/**
 * W5b — real spaces rail (replaces the wave-2 scaffold). Home is always the
 * first stop; spaces are name-sorted; DMs never appear (tree.ts owns the
 * filtering rules — this component only renders what it's handed).
 */
import { useRef, useState, type ReactNode } from "react";
import { useModalA11y } from "../a11y.js";
import type { RoomSummary } from "@linnet/core";

export interface SpaceRailProps {
  spaces: RoomSummary[];
  /** null = Home */
  active: string | null;
  onSelect: (spaceId: string | null) => void;
  /** Create-space dialog submits here; rejection surfaces the message. */
  onCreate: (name: string, isPublic: boolean) => Promise<void>;
}

export function SpaceRail({ spaces, active, onSelect, onCreate }: SpaceRailProps): ReactNode {
  const [creating, setCreating] = useState(false);
  // W8 a11y: focus trap + Escape + restore for the create-space dialog
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalA11y(dialogRef, () => setCreating(false), creating);
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // W12 item 6: two-letter badge kept as an ICON, but the FULL space name
  // always renders next to it — never abbreviated, never truncation-only.
  const initialsOf = (n: string): string =>
    n
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "S";

  async function submit(): Promise<void> {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), isPublic);
      setCreating(false);
      setName("");
      setIsPublic(false);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className={`space${active === null ? " active" : ""}`}
        aria-label="Home"
        aria-current={active === null ? "page" : undefined}
        onClick={() => onSelect(null)}
      >
        Home
      </button>
      {spaces.map((s) => (
        <button
          key={s.roomId}
          className={`space has-name${active === s.roomId ? " active" : ""}`}
          aria-label={`Space ${s.name}`}
          onClick={() => onSelect(s.roomId)}
        >
          <span className="space-ico" aria-hidden="true">
            {initialsOf(s.name)}
          </span>
          <span className="space-name">{s.name}</span>
        </button>
      ))}
      <button className="space add" aria-label="New space" disabled={busy} onClick={() => setCreating(true)}>
        +
      </button>
      {creating && (
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Create a new space" ref={dialogRef}>
          <strong>New space</strong>
          {error && <p role="alert">{error}</p>}
          <label>
            Name
            <input
              autoFocus
              aria-label="Space name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </label>
          <label className="check">
            <input type="checkbox" aria-label="Public space" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Public
          </label>
          <div className="dialog-actions">
            <button onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </button>
            <button className="primary" onClick={() => void submit()} disabled={!name.trim() || busy}>
              {busy ? "Creating…" : "Create space"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

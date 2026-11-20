/**
 * W14 item 7 — collapsible room-list sections. Headers become real buttons
 * (aria-expanded + chevron); collapsed keys persist per device in localStorage
 * so the list wakes up the way the user left it. Keys in use:
 *   "fav" | "people" | "rooms"  (home + group views)
 *   "sp:<spaceId>"              (a group's Rooms section)
 *   "dms:<spaceId>"             (a group's People section)
 *   "nested:<spaceRoomId>"      (nested space folds inside an entry)
 */
import { useState, type ReactNode } from "react";

const KEY = "linnet.sections.collapsed";

export function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, boolean>;
  } catch {
    /* storage off / private mode: sections just start expanded */
  }
  return {};
}

function persist(map: Record<string, boolean>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(map));
  } catch {
    /* non-fatal */
  }
}

export function useCollapsedSections(): {
  collapsed: Record<string, boolean>;
  toggle: (id: string) => void;
} {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadCollapsed());
  function toggle(id: string): void {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      persist(next);
      return next;
    });
  }
  return { collapsed, toggle };
}

export interface SectionHeaderProps {
  id: string;
  label: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  /** optional right-side affordance (e.g. count badge) */
  aside?: ReactNode;
  /** nesting level: 3 = pane sections, 4 = nested space folds */
  level?: 3 | 4;
}

export function SectionHeader({ id, label, collapsed, onToggle, aside, level = 3 }: SectionHeaderProps): ReactNode {
  const headingId = `section-${id.replace(/[^a-z0-9]/gi, "-")}`;
  const chevron = <span className="chev" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>;
  const inner = (
    <button className="section-toggle" aria-expanded={!collapsed} aria-controls={headingId} onClick={() => onToggle(id)}>
      {chevron}
      {label}
    </button>
  );
  return (
    <div className="section-head-row">
      {level === 3 ? (
        <h3 id={headingId} className="section-heading" data-section={id}>
          {inner}
        </h3>
      ) : (
        <h4 id={headingId} className="section-heading lv4" data-section={id}>
          {inner}
        </h4>
      )}
      {aside}
    </div>
  );
}

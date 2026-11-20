/**
 * W14 item 14 — individually resizable panels. Each pane (rail, room list,
 * right panel) gets a draggable gutter; widths persist per device and apply
 * as CSS custom properties (--rail / --roomlist / --panel) that the shell
 * grid and the panels already consume. Commits merge per-key so multiple
 * hook instances (App vs RoomView) never clobber each other's values.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type PaneId = "rail" | "roomlist" | "panel";
export interface PaneWidths { rail: number; roomlist: number; panel: number }

const KEY = "linnet.panes";
export const PANE_LIMITS: Record<PaneId, [number, number]> = {
  rail: [64, 340],
  roomlist: [200, 520],
  panel: [260, 560],
};
const DEFAULTS: PaneWidths = { rail: 240, roomlist: 300, panel: 340 };

export function loadPanes(): PaneWidths {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    const clamp = (p: PaneId, v: unknown): number => {
      const n = Number(v);
      if (!Number.isFinite(n)) return DEFAULTS[p];
      return Math.min(PANE_LIMITS[p][1], Math.max(PANE_LIMITS[p][0], n));
    };
    return { rail: clamp("rail", parsed.rail), roomlist: clamp("roomlist", parsed.roomlist), panel: clamp("panel", parsed.panel) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge-write ONE pane key (safe with concurrent hook instances). */
export function savePane(pane: PaneId, value: number): PaneWidths {
  const next = { ...loadPanes(), [pane]: value };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage off: session-only sizes are fine */
  }
  return next;
}

export function clampPane(pane: PaneId, value: number): number {
  if (!Number.isFinite(value)) return loadPanes()[pane];
  return Math.min(PANE_LIMITS[pane][1], Math.max(PANE_LIMITS[pane][0], Math.round(value)));
}

function applyVars(w: PaneWidths): void {
  const root = document.documentElement;
  root.style.setProperty("--rail", `${w.rail}px`);
  root.style.setProperty("--roomlist", `${w.roomlist}px`);
  root.style.setProperty("--panel", `${w.panel}px`);
}

interface DragStart { clientX: number; preventDefault?: () => void }

export function usePanes(): { startDrag: (pane: PaneId, e: DragStart) => void } {
  const [panes, setPanes] = useState<PaneWidths>(() => loadPanes());
  useEffect(() => applyVars(panes), [panes]);
  // while dragging, live updates go through the CSS var directly (no re-render
  // per pointermove); the final value is committed to state on release.
  const dragging = useRef<{ pane: PaneId; startX: number; startW: number } | null>(null);

  const startDrag = useCallback(
    (pane: PaneId, e: DragStart) => {
      e.preventDefault?.();
      const startW = loadPanes()[pane];
      dragging.current = { pane, startX: e.clientX, startW };
      const move = (ev: PointerEvent): void => {
        const d = dragging.current;
        if (!d) return;
        applyVars({ ...loadPanes(), [d.pane]: clampPane(d.pane, d.startW + (ev.clientX - d.startX)) });
      };
      const up = (ev: PointerEvent): void => {
        const d = dragging.current;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        dragging.current = null;
        if (!d) return;
        const w = clampPane(d.pane, d.startW + (ev.clientX - d.startX));
        setPanes(savePane(d.pane, w));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [],
  );

  return { startDrag };
}

export interface PaneGutterProps {
  pane: PaneId;
  startDrag: ReturnType<typeof usePanes>["startDrag"];
  label?: string;
}

export function PaneGutter({ pane, startDrag, label }: PaneGutterProps): ReactNode {
  return (
    <div
      className={`gutter gutter-${pane}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? `Resize ${pane}`}
      data-pane={pane}
      title="Drag to resize"
      onPointerDown={(e) => startDrag(pane, e)}
    />
  );
}

/**
 * W8 a11y: minimal modal focus management for role="dialog" surfaces.
 * On open: remember the invoker, pull focus to the first control inside.
 * While open: Tab cycles within the dialog; Escape invokes onClose.
 * On close: return focus to the invoker (WCAG 2.4.3 focus order).
 *
 * `open` must be the same boolean that conditionally renders the dialog —
 * effects run on its transitions only, so re-renders inside the dialog
 * (typing, etc.) never yank focus.
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function useModalA11y(ref: RefObject<HTMLElement | null>, onClose: () => void, open: boolean): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const invoker = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus?.();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? items[(at - 1 + items.length) % items.length]
        : items[(at + 1) % items.length];
      if (at === -1 || (at === items.length - 1 && !e.shiftKey) || (at === 0 && e.shiftKey)) {
        e.preventDefault();
        next?.focus?.();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      invoker?.focus?.();
    };
  }, [open, ref]);
}

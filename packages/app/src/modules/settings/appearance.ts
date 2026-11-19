/**
 * W8 theming: light/dark/system + accent, persisted per device (localStorage)
 * and applied to <html> as data-theme / data-accent. System mode follows
 * prefers-color-scheme live via a matchMedia listener.
 */

export type ThemeMode = "system" | "light" | "dark";
export type AccentId = "indigo" | "rose" | "teal" | "amber";

export interface Appearance {
  mode: ThemeMode;
  accent: AccentId;
}

export const ACCENTS: { id: AccentId; label: string; css: string }[] = [
  { id: "indigo", label: "Indigo", css: "#4f6bed" },
  { id: "rose", label: "Rose", css: "#e0533d" },
  { id: "teal", label: "Teal", css: "#1f9e8e" },
  { id: "amber", label: "Amber", css: "#d98e04" },
];

const KEY = "linnet.appearance";
const DEFAULTS: Appearance = { mode: "system", accent: "indigo" };

export function loadAppearance(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    const mode = ["system", "light", "dark"].includes(String(parsed.mode)) ? (parsed.mode as ThemeMode) : "system";
    const accent = ACCENTS.some((a) => a.id === parsed.accent) ? (parsed.accent as AccentId) : "indigo";
    return { mode, accent };
  } catch {
    return DEFAULTS;
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(a));
  } catch {
    /* private mode / disabled storage: session-only theme is fine */
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  return mode === "dark" || (mode === "system" && prefersDark) ? "dark" : "light";
}

export interface ThemeTargets {
  dataset: Record<string, string | undefined>;
  style?: { setProperty(name: string, value: string): void };
}

/** Pure DOM write: attributes on <html>. Testable without a real document. */
export function applyToElement(el: ThemeTargets, a: Appearance, prefersDark: boolean): void {
  el.dataset.theme = resolveTheme(a.mode, prefersDark);
  el.dataset.accent = a.accent;
  if (el.style && a.accent !== "indigo") {
    const hit = ACCENTS.find((x) => x.id === a.accent);
    if (hit) el.style.setProperty("--accent", hit.css);
  }
}

/** Boot wiring: apply now + re-apply when OS theme flips (system mode). */
export function mountAppearance(): (a: Appearance) => void {
  let current = loadAppearance();
  const mq = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const apply = (): void => applyToElement(document.documentElement, current, mq?.matches ?? false);
  apply();
  mq?.addEventListener?.("change", () => {
    if (current.mode === "system") apply();
  });
  return (a: Appearance) => {
    current = a;
    saveAppearance(a);
    apply();
  };
}

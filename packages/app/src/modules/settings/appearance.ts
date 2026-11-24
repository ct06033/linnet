/**
 * W8 theming: light/dark/system + accent, persisted per device (localStorage)
 * and applied to <html> as data-theme / data-accent. System mode follows
 * prefers-color-scheme live via a matchMedia listener.
 *
 * W21 items 5+8: the inline --accent override was ONE-WAY — picking indigo
 * after another accent left the stale inline value (the swatch "couldn't be
 * selected"). Accents now live purely in the [data-accent] CSS rules; the
 * inline channel is reserved for accent="system" (Windows DWM color, fed by
 * the desktop bridge via setSystemAccent). Blue and purple swatches added.
 */

export type ThemeMode = "system" | "light" | "dark";
export type AccentId = "indigo" | "blue" | "purple" | "rose" | "teal" | "amber" | "system";
// W12 item 3: display density — compact is the historic spacing (default)
export type DensityId = "compact" | "medium" | "relaxed";

export interface Appearance {
  mode: ThemeMode;
  accent: AccentId;
  /** W12 item 3; optional so every pre-density call site keeps typechecking */
  density?: DensityId;
}

export const ACCENTS: { id: AccentId; label: string; css: string }[] = [
  { id: "indigo", label: "Indigo", css: "#4f6bed" },
  { id: "blue", label: "Blue", css: "#2563eb" },
  { id: "purple", label: "Purple", css: "#8b5cf6" },
  { id: "rose", label: "Rose", css: "#e0533d" },
  { id: "teal", label: "Teal", css: "#1f9e8e" },
  { id: "amber", label: "Amber", css: "#d98e04" },
  // W21 item 8: OS accent (Windows DWM). css "" = nothing to preview; the
  // swatch paints itself from whatever setSystemAccent last delivered.
  { id: "system", label: "System", css: "" },
];

export const DENSITIES: { id: DensityId; label: string }[] = [
  { id: "compact", label: "compact" },
  { id: "medium", label: "medium" },
  { id: "relaxed", label: "relaxed" },
];

const KEY = "linnet.appearance";
const DEFAULTS: Appearance = { mode: "system", accent: "indigo", density: "compact" };

export function loadAppearance(): Appearance {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    const mode = ["system", "light", "dark"].includes(String(parsed.mode)) ? (parsed.mode as ThemeMode) : "system";
    const accent = ACCENTS.some((a) => a.id === parsed.accent) ? (parsed.accent as AccentId) : "indigo";
    const density = DENSITIES.some((d) => d.id === parsed.density) ? (parsed.density as DensityId) : "compact";
    return { mode, accent, density };
  } catch {
    return DEFAULTS;
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(a));
  } catch {
    /* private mode: theme just won't persist */
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  return mode === "dark" || (mode === "system" && prefersDark) ? "dark" : "light";
}

export interface ThemeTargets {
  dataset: Record<string, string | undefined>;
  style?: { setProperty(name: string, value: string): void; removeProperty?(name: string): void };
}

/** W21 item 8: the OS accent hex delivered by the desktop bridge (win only). */
let systemAccent: string | null = null;

export function getSystemAccent(): string | null {
  return systemAccent;
}

/** Indigo is the :root default in styles.css and stays the fallback when the
 *  OS has no usable accent (non-Windows, or accents disabled). */
const FALLBACK_ACCENT = "#4f6bed";

/**
 * Pure DOM write: attributes on <html>. Testable without a real document.
 * W21: accent selection is now REVERSIBLE — the inline --accent only exists
 * for accent="system"; every named accent clears it so the CSS attribute
 * rules take over (the old code never removed it, freezing the last pick).
 */
export function applyToElement(el: ThemeTargets, a: Appearance, prefersDark: boolean): void {
  el.dataset.theme = resolveTheme(a.mode, prefersDark);
  el.dataset.accent = a.accent;
  // W12 item 3: density rides the same <html> attribute channel
  el.dataset.density = a.density ?? "compact";
  if (!el.style) return;
  if (a.accent === "system" && systemAccent) el.style.setProperty("--accent", systemAccent);
  else if (el.style.removeProperty) el.style.removeProperty("--accent");
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

/**
 * W21 item 8: feed the OS accent (hex or null) from the desktop bridge and
 * re-apply. When the picked accent is "system" the live value must repaint
 * immediately, so this goes through the same channel as switchAppearance.
 */
export function setSystemAccent(hex: string | null): void {
  systemAccent = hex;
  const a = loadAppearance();
  if (a.accent === "system") {
    applyToElement(document.documentElement, a, false);
  }
}

export const ACCENT_FALLBACK = FALLBACK_ACCENT;

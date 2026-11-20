// @vitest-environment node
// (vitest jsdom stubs CSS imports — this suite is pure stylesheet parsing.)
/**
 * W16 item 2 — UX consistency gates (Sean: "ux tests for spacing, click
 * through, visual consistency"). These are STATIC analyses over styles.css,
 * deliberately: jsdom never cascades an external stylesheet, so a
 * getComputedStyle assertion on a class is meaningless in the harness, but the
 * real regression classes we keep hitting are stylesheet-level and ARE testable
 * by parsing the source:
 *
 *  - un-themed surface  → W12 item 9 (security sheet dark-on-dark in light mode)
 *  - theme drift        → item 8   (scrollbar / explicit-theme vs media fallback)
 *  - off-scale spacing  → item 2   (sub-pixel + arbitrary gaps)
 *  - missing focus ring → a11y / click-through affordance
 *
 * Click-through / navigation is covered behaviourally by the nav + RoomView
 * suites; the gap these tests close is visual/structural consistency.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

/** Strip /* … *\/ comments so commented-out rules never count as coverage. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** All custom properties DEFINED anywhere (--x: …). */
const definedTokens = new Set<string>();
for (const m of code.matchAll(/(--[a-z0-9-]+)\s*:/g)) definedTokens.add(m[1]!);

/** Rules shaped as `selector { body }` (top-level; density blocks are matched
 *  separately because their selector carries a descendant). */
interface Rule {
  selector: string;
  body: string;
}
const rules: Rule[] = [];
for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  rules.push({ selector: m[1]!.trim(), body: m[2]!.trim() });
}

/** True for the blocks that LEGITIMATELY hard-code theme colours. */
const isTokenBlock = (sel: string): boolean =>
  sel.startsWith(":root") ||
  sel.includes("[data-theme=") ||
  sel.includes(":not([data-theme])") ||
  /\[data-accent=/.test(sel);

describe("UX gates · token integrity", () => {
  it("every var(--x) reference resolves to a defined token", () => {
    const dangling = new Set<string>();
    for (const m of code.matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (!definedTokens.has(m[1]!)) dangling.add(m[1]!);
    }
    // A dangling token is how the W12 dark-on-dark sheet happened.
    expect([...dangling], "undefined CSS custom properties in use").toEqual([]);
  });

  it("defines the core palette tokens", () => {
    for (const t of ["--bg", "--bg-alt", "--fg", "--fg-dim", "--line", "--accent", "--danger", "--border", "--bg-elev", "--bg-input"]) {
      expect(definedTokens.has(t), `missing token ${t}`).toBe(true);
    }
  });
});

describe("UX gates · theme parity (item 8)", () => {
  const tokensIn = (sel: string): Set<string> => {
    const r = rules.find((x) => x.selector.replace(/\s+/g, " ") === sel);
    const set = new Set<string>();
    if (r) for (const m of r.body.matchAll(/(--[a-z0-9-]+)\s*:/g)) set.add(m[1]!);
    return set;
  };

  it("explicit dark == media-query dark (no drift between the two dark paths)", () => {
    const explicit = tokensIn('[data-theme="dark"]');
    const fallback = tokensIn(':root:not([data-theme])');
    expect(explicit.size, "explicit dark defines tokens").toBeGreaterThan(4);
    // They must override the exact same set, else prefers-color-scheme and the
    // in-app toggle diverge for whatever token is missing from one side.
    expect([...explicit].filter((t) => !fallback.has(t)), "in explicit-dark only").toEqual([]);
    expect([...fallback].filter((t) => !explicit.has(t)), "in media-dark fallback only").toEqual([]);
  });
});

describe("UX gates · visual consistency (no un-themed surfaces)", () => {
  /** Neutral black/white washes (scrims, hover veils) + letterbox blacks +
   *  fixed brand marks are theme-safe by design; anything ELSE that hard-codes
   *  a colour for a background must come through a var() token. */
  const BENIGN_LITERALS = [
    /^rgba?\(\s*(?:0[,\s]+0[,\s]+0|255[,\s]+255[,\s]+255|0 0 0|255 255 255)\b/i, // neutral wash/scrim
    /^#(?:000|111|000000|111111)$/i, // letterbox
    /^rgba?\(\s*220[,\s]+40[,\s]+40\b/i, // YouTube brand red
  ];
  const isBenign = (lit: string): boolean => BENIGN_LITERALS.some((re) => re.test(lit));

  it("no component rule hard-codes a background colour instead of a token", () => {
    const offenders: string[] = [];
    for (const r of rules) {
      if (isTokenBlock(r.selector)) continue;
      for (const m of r.body.matchAll(/background(?:-color)?\s*:\s*([^;{}]+)/g)) {
        // var(...) fallbacks are token-derived once the var() spans resolve —
        // strip them (and transparent/currentColor) before hunting literals.
        let v = m[1]!.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "T").replace(/transparent|currentColor/gi, "");
        for (const lit of v.matchAll(/#[0-9a-fA-F]{3,8}|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g)) {
          if (!isBenign(lit[0]!)) offenders.push(`${r.selector} → ${lit[0]}`);
        }
      }
    }
    expect(offenders, "literal background colours (use a var() token)").toEqual([]);
  });

  it("every box-shadow stays neutral so it reads on both themes (item 8)", () => {
    const bad: string[] = [];
    for (const m of code.matchAll(/box-shadow\s*:\s*([^;{}]+)/g)) {
      const v = m[1]!;
      // allow rgb(0 0 0 / n%) black-alpha, var() tokens, inset, and `none`
      const cleaned = v
        .replace(/rgb\(\s*0\s+0\s+0\s*\/[^)]*\)/g, "")
        .replace(/var\(--[a-z0-9-]+\)/g, "")
        .replace(/\binset\b|none|px|%\s|,|\s/gi, "");
      // anything left that still looks like a colour literal is a theme trap
      if (/(#[0-9a-fA-F]{3,8}|\brgba?\(|\bhsla?\()/.test(cleaned)) bad.push(v.trim());
    }
    expect(bad, "coloured box-shadows (use rgb(0 0 0 / alpha) or a token)").toEqual([]);
  });
});

describe("UX gates · spacing discipline (item 2)", () => {
  it("no sub-pixel spacing values (blurry on 1x displays)", () => {
    const fractional: string[] = [];
    for (const m of code.matchAll(/(?:margin|padding|gap|row-gap|column-gap)[^:]*:\s*([^;{}]+)/g)) {
      for (const v of m[1]!.matchAll(/(-?\d+\.\d+px)/g)) fractional.push(v[1]!);
    }
    expect(fractional, "fractional-px spacing").toEqual([]);
  });

  it("density modes stay in lockstep (every selector medium nudges, relaxed nudges)", () => {
    const dens = (mode: string): Set<string> => {
      const s = new Set<string>();
      const re = new RegExp(`\\[data-density="${mode}"\\]\\s+([^{]+)\\{`, "g");
      for (const m of code.matchAll(re)) s.add(m[1]!.trim());
      return s;
    };
    const medium = dens("medium");
    const relaxed = dens("relaxed");
    expect(medium.size, "medium density has rules").toBeGreaterThan(2);
    const missing = [...medium].filter((sel) => !relaxed.has(sel));
    expect(missing, "selectors styled at medium but not relaxed").toEqual([]);
  });
});

describe("UX gates · affordance (click-through / keyboard)", () => {
  it("declares a global visible focus ring", () => {
    const focus = rules.find((r) => r.selector === ":focus-visible");
    expect(focus, "a :focus-visible rule must exist").toBeTruthy();
    expect(focus!.body).toMatch(/outline\s*:\s*\d/);
    expect(focus!.body).toMatch(/var\(--accent\)/);
  });

  it("provides a skip-link for keyboard users", () => {
    expect(/\.skip-link\s*\{/.test(code)).toBe(true);
    expect(/\.skip-link:focus\s*\{/.test(code)).toBe(true);
  });
});

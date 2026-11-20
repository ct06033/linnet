// Layout contract (field bug 2026-11-20): scrolling the chat pushed the WHOLE
// UI up — Chromium measurement proved the timeline subtree grew past the
// window (.scroller clientHeight==scrollHeight, body scrolled programmatically
// to 423px with the header at -423). jsdom cannot do layout, so this test
// guards the exact CSS rules that make the vertical scroll chain self-limiting;
// geometry itself is verified live via the CDP probe (vault Linnet.md).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles.css", "utf8"); // vitest cwd = packages/app
const rulesFor = (selector: string): string[] => {
  const out: string[] = [];
  let at = css.indexOf(selector + " {");
  while (at >= 0) {
    out.push(css.slice(at, css.indexOf("}", at)));
    at = css.indexOf(selector + " {", at + 1);
  }
  if (out.length === 0) throw new Error(`no rule for ${selector}`);
  return out;
};
const someRule = (selector: string, re: RegExp): boolean => rulesFor(selector).some((r) => re.test(r));

describe("layout contract (chat scroll must not move the shell)", () => {
  it("html+body refuse scripted scrolling too (overflow:clip over hidden)", () => {
    const r = rulesFor("html, body")[0];
    expect(r).toMatch(/overflow:\s*hidden/);
    expect(r).toMatch(/overflow:\s*clip/);
  });

  it("the shell grid row is content-proof: minmax(0, 1fr)", () => {
    expect(someRule(".shell", /grid-template-rows:\s*minmax\(0,\s*1fr\)/)).toBe(true);
  });

  it("col-main carries min-height:0 (the missing link, twice-burned)", () => {
    expect(someRule("main.roomview .col-main", /min-height:\s*0/)).toBe(true);
  });

  it("every flex item in the vertical chain caps itself (roomview, body, scroller)", () => {
    expect(someRule("main.roomview", /min-height:\s*0/)).toBe(true);
    expect(someRule("main.roomview .body", /min-height:\s*0/)).toBe(true);
    expect(someRule(".scroller", /min-height:\s*0/)).toBe(true);
    expect(someRule(".scroller", /overflow-y:\s*auto/)).toBe(true);
  });
});

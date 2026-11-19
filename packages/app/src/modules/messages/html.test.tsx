import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./html.js";

describe("sanitizer (spec allow-list)", () => {
  it("keeps allowed formatting", () => {
    const out = sanitizeHtml('<b>bold</b> <em>it</em> <code>c</code> <pre><code>x=1</code></pre>');
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<em>it</em>");
    expect(out).toContain("<pre><code>x=1</code></pre>");
  });

  it("keeps safe links and forces noopener", () => {
    const out = sanitizeHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it("drops javascript: hrefs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("strips scripts and event handlers", () => {
    const out = sanitizeHtml('<script>alert(1)</script><img alt="x" onerror="alert(2)"><span>y</span>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("onerror");
    expect(out).toContain("<span>y</span>");
  });

  it("strips iframes entirely", () => {
    const out = sanitizeHtml('<iframe src="https://evil.test">embed</iframe><p>ok</p>');
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("evil");
    expect(out).toContain("ok");
  });

  it("allows only known class values", () => {
    expect(sanitizeHtml('<span class="mx-spoiler">s</span>')).toContain('class="mx-spoiler"');
    expect(sanitizeHtml('<span class="bigred">s</span>')).not.toContain("bigred");
  });

  it("preserves spoiler details/summary", () => {
    const out = sanitizeHtml('<details class="mx-spoiler"><summary>Spoiler</summary>secret</details>');
    expect(out).toContain("<details");
    expect(out).toContain("secret");
  });

  it("unwraps unknown tags but keeps their text", () => {
    const out = sanitizeHtml("<marquee>hi</marquee>");
    expect(out).not.toContain("marquee");
    expect(out).toContain("hi");
  });

  it("escapes raw angle bracket text", () => {
    const out = sanitizeHtml("<span>a &lt;script&gt; b</span>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("keeps mx-reply blocks (rendered as quote chrome upstream)", () => {
    const out = sanitizeHtml('<mx-reply><blockquote>q</blockquote></mx-reply>text');
    expect(out).toContain("mx-reply");
    expect(out).toContain("q");
  });
});

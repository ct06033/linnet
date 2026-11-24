import { describe, expect, it } from "vitest";
import { mdToHtml, expandShortcodes, stripFallbackQuote, wrapCodeBlock, plainToHtml } from "./markdown.js";

describe("mdToHtml", () => {
  it("bold/italic/strike/code", () => {
    expect(mdToHtml("**b**")).toBe("<strong>b</strong>");
    expect(mdToHtml("*i*")).toBe("<em>i</em>");
    expect(mdToHtml("~~s~~")).toBe("<del>s</del>");
    expect(mdToHtml("`c`")).toBe("<code>c</code>");
  });

  it("fences protect inner markdown", () => {
    const out = mdToHtml("```\n**not bold**\n```");
    expect(out).toContain("<pre><code>**not bold**</code></pre>");
  });

  it("links", () => {
    expect(mdToHtml("[x](https://a.test)")).toContain('<a href="https://a.test">x</a>');
    expect(mdToHtml("see https://a.test now")).toContain('<a href="https://a.test">https://a.test</a>');
  });

  it("blocks unsafe link schemes from becoming hrefs", () => {
    const out = mdToHtml("[x](javascript:alert(1))");
    expect(out).not.toContain("<a");
    expect(out).toContain("[x](javascript:alert(1))"); // harmless literal text
  });

  it("spoilers", () => {
    expect(mdToHtml("||hidden||")).toContain("mx-spoiler");
    expect(mdToHtml("||hidden||")).toContain("hidden");
  });

  it("newlines become br", () => {
    expect(mdToHtml("a\nb")).toBe("a<br/>b");
  });

  it("escapes html in plain text", () => {
    expect(mdToHtml("<img src=x onerror=1>")).not.toContain("<img");
  });
});

describe("shortcodes", () => {
  it("expands known", () => {
    expect(expandShortcodes(":tada: party")).toBe("🎉 party");
    expect(expandShortcodes(":+1:")).toBe("👍");
  });
  it("leaves unknown intact", () => {
    expect(expandShortcodes(":notacode:")).toBe(":notacode:");
  });
});

describe("fallback quotes", () => {
  it("strips mx-reply block", () => {
    expect(stripFallbackQuote("<mx-reply><blockquote>x</blockquote></mx-reply>real"))
      .toBe("real");
  });
});

describe("code block command", () => {
  it("wraps selection", () => {
    expect(wrapCodeBlock("run x here", "x")).toContain("```\nx\n```");
  });
});


describe("W21 item 12: plainToHtml (received plain bodies get links too)", () => {
  it("linkifies bare https and www URLs", () => {
    const h = plainToHtml("see https://ex.test/a?x=1 and www.ex.test/b now");
    expect(h).toContain('<a href="https://ex.test/a?x=1"');
    expect(h).toContain('<a href="https://www.ex.test/b"');
  });
  it("linkifies [label](url) only for safe schemes", () => {
    expect(plainToHtml("[ok](https://ex.test)")).toContain('<a href="https://ex.test" target="_blank" rel="noopener">ok</a>');
    const bad = plainToHtml("[nope](javascript:alert(1))");
    expect(bad).not.toContain("<a");
    expect(bad).toContain("[nope]");
  });
  it("escapes HTML first — injected markup stays inert", () => {
    const h = plainToHtml('<img src=x onerror=alert(1)> hi');
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
  it("newlines become <br/>", () => {
    expect(plainToHtml("a\nb")).toBe("a<br/>b");
  });
});

/**
 * Markdown → HTML for the composer pipeline (PRD §6.2: markdown composer;
 * org.matrix.custom.html). Pure + tested; deliberately small subset matching
 * common chat usage. Falls back to plain text for anything unsupported.
 */

export function escapeHtml(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function mdToHtml(src: string): string {
  // code fences first (protected)
  const fences: string[] = [];
  let text = src.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(`<pre><code>${escapeHtml(code.replace(/^\n|\n$/g, ""))}</code></pre>`);
    return `\u0000F${fences.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  // inline code (protected)
  const inlines: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlines.push(`<code>${code}</code>`);
    return `\u0000I${inlines.length - 1}\u0000`;
  });

  text = text
    .replace(/\|\|([^|\n]+)\|\|/g, '<details class="mx-spoiler"><summary>Spoiler</summary>$1</details>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~+([^~\n]+)~+/g, "<del>$1</del>")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
      /^(https?:|matrix:|mailto:)/i.test(url) ? `<a href="${url}">${label}</a>` : _m,
    );

  // bare URLs
  text = text.replace(
    /(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    '$1<a href="$2">$2</a>',
  );

  // lists + line breaks
  text = text
    .split("\n")
    .map((line) => {
      const li = line.match(/^\s*[-*] (.*)$/);
      if (li) return `<li>${li[1]}</li>`;
      return line;
    })
    .join("\n")
    .replace(/(<\/li>)\n(<li>)/g, "$1$2")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\n?<li>)/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n/g, "<br/>");

  text = text.replace(/\u0000I(\d+)\u0000/g, (_m, i: string) => inlines[Number(i)]!);
  text = text.replace(/\u0000F(\d+)\u0000/g, (_m, i: string) => fences[Number(i)]!);
  return text;
}

/** Reply fallback-quote stripping for formatted_body (<mx-reply>…</mx-reply>). */
export function stripFallbackQuote(html: string): string {
  return html
    .replace(/^<mx-reply>[\s\S]*?<\/mx-reply>\s*/i, "")
    .replace(/^<mx-mxk>[\s\S]*?<\/mx-mxk>\s*/i, "")
    .replace(/^<blockquote>\s*&gt; ?[\s\S]*?<\/blockquote>\s*/i, "");
}

/**
 * W21 item 12: render-side linkification for PLAIN message bodies (received
 * as m.text without formatted_body — the old path printed them verbatim, so
 * bare URLs from other clients were never clickable). Escape first, then
 * [label](url) + bare https?:// → anchors, newlines → <br>. The output only
 * ever contains <a>/<br> we minted with safe schemes, so it is XSS-safe.
 */
export function plainToHtml(src: string): string {
  let t = escapeHtml(src);
  // target=_blank keeps the Electron window pinned to Linnet: new-window
  // requests go through setWindowOpenHandler → shell.openExternal (main.ts).
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    /^(https?:|matrix:|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : _m,
  );
  t = t.replace(
    /(^|[\s(])((?:https?:\/\/|www\.)[^\s<)]+)/g,
    (_m, pre: string, url: string) => {
      const href = url.startsWith("www.") ? `https://${url}` : url;
      return `${pre}<a href="${href}" target="_blank" rel="noopener">${url}</a>`;
    },
  );
  return t.replace(/\n/g, "<br/>");
}

const SHORTCODES: Record<string, string> = {
  tada: "🎉", smile: "😄", grin: "😁", joy: "😂", wink: "😉",
  heart: "❤️", thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎",
  ok_hand: "👌", clap: "👏", wave: "👋", fire: "🔥", sparkles: "✨",
  eyes: "👀", thinking: "🤔", cry: "😢", rage: "😡", sweat: "😓",
  shrug: "🤷", rocket: "🚀", star: "⭐", check: "✅", x: "❌",
  warning: "⚠️", bug: "🐛", coffee: "☕", pizza: "🍕", beer: "🍺",
};

/** Expand :shortcode: for known codes; leave unknown ones intact. */
export function expandShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (m, name: string) => SHORTCODES[name] ?? m);
}

/** Insert a Markdown code block around selected text (composer-command demo). */
export function wrapCodeBlock(text: string, selection: string): string {
  const idx = text.indexOf(selection);
  if (idx < 0 || !selection) return "```\n\n```";
  return `\`\`\`\n${selection}\n\`\`\``;
}

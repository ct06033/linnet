/**
 * Spec-allow-list HTML sanitizer for formatted_body (PRD §6.2: HTML
 * formatted-message sanitising render; no third-party dep). DOMParser-based;
 * runs in the renderer (jsdom in tests).
 */

const ALLOWED: Record<string, Record<string, readonly string[]>> = {
  A: { href: [], title: [], target: [], rel: [] },
  EM: {}, STRONG: {}, DEL: {}, U: {}, S: {}, I: {}, B: {},
  CODE: {}, PRE: {}, BLOCKQUOTE: {}, BR: {}, HR: {},
  UL: {}, OL: {}, LI: {},
  DIV: { class: [] }, SPAN: { class: [] },
  H1: {}, H2: {}, H3: {}, H4: {}, H5: {}, H6: {},
  IMG: { src: [], alt: [], title: [] },
  TABLE: {}, THEAD: {}, TBODY: {}, TR: {}, TH: { colspan: [], rowspan: [] }, TD: { colspan: [], rowspan: [] },
  DETAILS: {}, SUMMARY: {},
  MX_MXK: {}, "MX-REPLY": {},
};

const SAFE_URL = /^(https?:|matrix:|mailto:|mxc:|#)/i;

// class values we honor for formatted messages (spoilers, syntax-highlight spans)
const ALLOWED_CLASS = /^(mx-(spoiler|highlight(_[a-z0-9]+)?|pill(_[^"]*)?)|language-[a-z0-9+#-]+)$/i;

export function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(wrap(dirty), "text/html");
  const root = (doc.body.firstChild ?? doc.body) as Element;
  scrubContainer(root);
  return innerHtml(root);
}

function wrap(html: string): string {
  return `<div>${html}</div>`;
}

function scrubContainer(el: Element): void {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toUpperCase();
    if (!(tag in ALLOWED)) {
      // drop dangerous subtrees entirely, keep text of merely-unknown tags
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM"].includes(tag)) {
        child.remove();
      } else {
        unwrap(child);
      }
      continue;
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      const allowed = ALLOWED[tag]![Object.keys(ALLOWED[tag]!).find((k) => k.toLowerCase() === name) ?? ""] ?? undefined;
      const known = Object.keys(ALLOWED[tag]!).some((k) => k.toLowerCase() === name);
      if (!known || !allowed) {
        child.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" && !SAFE_URL.test(attr.value)) {
        child.removeAttribute(attr.name);
      } else if (name === "src" && !/^(mxc:|https?:)/i.test(attr.value)) {
        child.removeAttribute(attr.name);
      } else if (name === "class" && !Array.from(attr.value.split(/\s+/)).every((c) => c === "" || ALLOWED_CLASS.test(c))) {
        child.removeAttribute(attr.name);
      }
    }
    if (tag === "A") {
      child.setAttribute("rel", "noreferrer noopener");
      child.setAttribute("target", "_blank");
    }
    scrubContainer(child);
  }
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function innerHtml(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += escapeText(node.textContent ?? "");
    else if (node.nodeType === 1) {
      const e = node as Element;
      const tag = e.tagName.toLowerCase();
      const attrs = Array.from(e.attributes)
        .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
        .join("");
      out += `<${tag}${attrs}>${innerHtml(e)}</${tag}>`;
    }
  }
  return out;
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** mxc:// to a homeserver media URL (viewer chrome lands W4c). */
export function mxcUrl(mxc: string, homeserverUrl: string): string {
  const rest = mxc.replace(/^mxc:\/\//, "");
  return `${homeserverUrl}/_matrix/media/v3/download/${rest}`;
}

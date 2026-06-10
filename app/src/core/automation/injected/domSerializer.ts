/**
 * The injected perceiver (PROCURE_COPILOT_PLAN.md §3.5.4).
 *
 * `serializeDom` is a PURE function over a `Document`/`Window` so it can be unit-tested under jsdom
 * and reused by the in-process MockBridge. It walks the document (piercing open shadow roots and
 * same-origin iframes), keeps only interactable + visible nodes, tags each with a stable
 * `data-pc-idx` handle, and returns a compact `Observation`.
 *
 * `buildSerializerScript` returns the equivalent self-contained IIFE *string* that the real Capgo
 * bridge injects into the live webview; it posts the same shape back over
 * `window.mobileApp.postMessage`.
 */
import type { Observation, SerializedElement } from "../AutomationEngine";
import { encodeScriptMeta } from "./scriptProtocol";
import { bridgeEmitFnSource } from "./bridgeEmit";

const INTERACTIVE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "OPTION",
  "LABEL",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "option",
  "combobox",
  "searchbox",
  "textbox",
]);

// Product tiles render title → weight → rating → price in one clickable element; 120 chars truncated
// before the price on Hyperpure's longer SKU names. 200 keeps the price in `name` without bloating the
// token budget much (most elements are far shorter than the cap).
const MAX_NAME_LEN = 200;

export interface SerializeOptions {
  /** Cap the number of serialized elements to keep the token budget bounded (§3.5.4). */
  readonly maxElements?: number;
}

export function serializeDom(
  doc: Document,
  win: Window,
  opts: SerializeOptions = {},
): Observation {
  const out: SerializedElement[] = [];
  const maxElements = opts.maxElements ?? Number.POSITIVE_INFINITY;
  let idx = 0;

  const walk = (root: ParentNode): void => {
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) walk(shadow);
      if (out.length >= maxElements) return;
      if (!isInteractive(el, win) || !isVisible(el, win)) continue;
      el.setAttribute("data-pc-idx", String(idx));
      out.push(serializeElement(el, idx));
      idx++;
    }
  };

  walk(doc);

  // Same-origin iframes only; cross-origin reads throw and are skipped by design (§3.5.4).
  const iframes = doc.querySelectorAll("iframe");
  for (let i = 0; i < iframes.length; i++) {
    try {
      const cdoc = (iframes[i] as HTMLIFrameElement).contentDocument;
      if (cdoc) walk(cdoc);
    } catch {
      /* cross-origin: unreadable, hand off to human where it matters (payment) */
    }
  }

  const body = doc.body as HTMLElement | null;
  return {
    url: readUrl(doc, win),
    title: doc.title,
    scroll: {
      y: numOr(win.scrollY, 0),
      h: numOr(body ? body.scrollHeight : 0, 0),
      vh: numOr(win.innerHeight, 0),
    },
    elements: out,
  };
}

function serializeElement(el: Element, idx: number): SerializedElement {
  const rect = el.getBoundingClientRect();
  const role = el.getAttribute("role");
  return {
    idx,
    tag: el.tagName.toLowerCase(),
    role: role && role.length > 0 ? role : null,
    name: readName(el),
    value: readValue(el),
    bbox: [
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
    ],
    attrs: {
      type: readType(el),
      name: el.getAttribute("name"),
      href: el.getAttribute("href"),
    },
  };
}

function isInteractive(el: Element, win: Window): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute("onclick")) return true;
  const tabIndex = (el as HTMLElement).tabIndex;
  if (typeof tabIndex === "number" && tabIndex >= 0) return true;
  if (win.getComputedStyle(el).cursor === "pointer") return true;
  return false;
}

function isVisible(el: Element, win: Window): boolean {
  let node: Element | null = el;
  while (node) {
    if (typeof node.hasAttribute === "function" && node.hasAttribute("hidden")) {
      return false;
    }
    const style = win.getComputedStyle(node);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    const opacity = style.opacity;
    if (opacity !== "" && opacity != null && parseFloat(opacity) === 0) {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

function readName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  const he = el as HTMLElement;
  const innerText = typeof he.innerText === "string" ? he.innerText : "";
  const text = innerText || he.textContent || "";
  const value = readValue(el);
  const placeholder = (el as HTMLInputElement).placeholder;
  const alt = (el as HTMLImageElement).alt;
  const raw = aria || text || value || placeholder || alt || "";
  return raw.trim().slice(0, MAX_NAME_LEN);
}

function readValue(el: Element): string | null {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") {
    const v = (el as HTMLInputElement).value;
    return typeof v === "string" ? v : null;
  }
  return null;
}

function readType(el: Element): string | null {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "BUTTON") {
    const t = (el as HTMLInputElement).type;
    return t || null;
  }
  return el.getAttribute("type");
}

function readUrl(doc: Document, win: Window): string {
  try {
    if (win.location && win.location.href) return win.location.href;
  } catch {
    /* opaque-origin location access can throw */
  }
  return doc.URL ?? "";
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The injectable, self-contained perceiver string. Mirrors `serializeDom` but runs in the live
 * webview and posts the result back over the Capgo bridge (§3.5.4). It is never executed in tests
 * (the MockBridge runs `serializeDom` instead, keyed off the encoded metadata header).
 */
export function buildSerializerScript(requestId: string): string {
  const meta = encodeScriptMeta({ kind: "dom", requestId });
  const interactiveTags = JSON.stringify([...INTERACTIVE_TAGS]);
  const interactiveRoles = JSON.stringify([...INTERACTIVE_ROLES]);
  return `${meta}
(function () {
  ${bridgeEmitFnSource()}
  var RID = ${JSON.stringify(requestId)};
  var TAGS = ${interactiveTags};
  var ROLES = ${interactiveRoles};
  var MAX = ${MAX_NAME_LEN};
  var out = [];
  var idx = 0;
  function visible(el) {
    var node = el;
    while (node) {
      if (node.hasAttribute && node.hasAttribute('hidden')) return false;
      var s = getComputedStyle(node);
      if (s.display === 'none') return false;
      if (s.visibility === 'hidden' || s.visibility === 'collapse') return false;
      if (s.opacity !== '' && parseFloat(s.opacity) === 0) return false;
      node = node.parentElement;
    }
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function interactive(el) {
    if (TAGS.indexOf(el.tagName) >= 0) return true;
    var role = el.getAttribute('role');
    if (role && ROLES.indexOf(role) >= 0) return true;
    if (el.hasAttribute('onclick')) return true;
    if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) return true;
    if (getComputedStyle(el).cursor === 'pointer') return true;
    return false;
  }
  function name(el) {
    var raw = el.getAttribute('aria-label') || el.innerText || el.value ||
      el.placeholder || el.alt || el.textContent || '';
    return ('' + raw).trim().slice(0, MAX);
  }
  function walk(root) {
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!interactive(el) || !visible(el)) continue;
      el.setAttribute('data-pc-idx', idx);
      var r = el.getBoundingClientRect();
      var tag = el.tagName;
      out.push({
        idx: idx,
        tag: tag.toLowerCase(),
        role: el.getAttribute('role') || null,
        name: name(el),
        value: (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION')
          ? (typeof el.value === 'string' ? el.value : null) : null,
        bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        attrs: {
          type: el.type || el.getAttribute('type') || null,
          name: el.getAttribute('name'),
          href: el.getAttribute('href')
        }
      });
      idx++;
    }
  }
  walk(document);
  var frames = document.querySelectorAll('iframe');
  for (var f = 0; f < frames.length; f++) {
    try { if (frames[f].contentDocument) walk(frames[f].contentDocument); } catch (e) {}
  }
  __hpEmit(RID, {
    requestId: RID, type: 'dom',
    url: location.href, title: document.title,
    scroll: { y: scrollY, h: document.body ? document.body.scrollHeight : 0, vh: innerHeight },
    elements: out
  });
})();`;
}

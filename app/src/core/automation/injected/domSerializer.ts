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

// Hyperpure renders its price footer (e.g. "₹389", "₹38.9/kg") in plain non-interactive nodes that
// the interactivity gate drops, so DOM price extraction saw priced=0 and fell back to stub data. We
// additionally serialize the *smallest* element carrying a rupee price (a child with no priced
// descendant) so the price reaches the Observation without flooding it with parent containers.
const PRICE_LEAF_RE = /(?:₹|rs\.?|inr)\s*[\d,]/i;

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
      if (!isInteractive(el, win) && !isPriceLeaf(el)) continue;
      if (!isVisible(el, win)) continue;
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

function isPriceLeaf(el: Element): boolean {
  const he = el as HTMLElement;
  const text = (typeof he.innerText === "string" ? he.innerText : he.textContent) || "";
  if (!PRICE_LEAF_RE.test(text)) return false;
  const kids = el.querySelectorAll("*");
  for (let i = 0; i < kids.length; i++) {
    const kt =
      (kids[i] as HTMLElement).innerText || kids[i].textContent || "";
    if (PRICE_LEAF_RE.test(kt)) return false;
  }
  return true;
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

/** One candidate control surfaced by the debug checkout probe (quantity selector / add-to-cart / stepper). */
export interface CheckoutProbeCandidate {
  readonly group: "quantity" | "addToCart" | "stepper";
  readonly tag: string;
  readonly id: string;
  readonly cls: string;
  readonly nameAttr: string;
  readonly type: string;
  readonly value: string;
  readonly text: string;
  readonly aria: string;
  readonly idx: string;
}

/**
 * Debug-only probe that dumps the REAL identifiers (id / class / name / type) of a checkout page's
 * quantity selector, add-to-cart button/form, and +/- steppers — the exact attributes the lean
 * perceiver omits to stay small. This is what lets us wire a precise, re-injection-safe `findQuantitySelector`
 * / `findAddToCart` against Amazon's actual mobile DOM instead of guessing. Runs only when automation
 * debug is on, and only on the real Capgo bridge (never in tests / MockBridge).
 */
export function buildCheckoutProbeScript(requestId: string): string {
  const meta = encodeScriptMeta({ kind: "dom", requestId });
  return `${meta}
(function () {
  ${bridgeEmitFnSource()}
  var RID = ${JSON.stringify(requestId)};
  function pick(group, list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el || !el.tagName) continue;
      out.push({
        group: group,
        tag: el.tagName.toLowerCase(),
        id: (el.id || '').slice(0, 60),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 140),
        nameAttr: (el.getAttribute && el.getAttribute('name') || '').slice(0, 60),
        type: (el.type || el.getAttribute && el.getAttribute('type') || '').slice(0, 30),
        value: (typeof el.value === 'string' ? el.value : '').slice(0, 30),
        text: ((el.innerText || el.textContent || '').trim()).slice(0, 60),
        aria: (el.getAttribute && el.getAttribute('aria-label') || '').slice(0, 60),
        idx: (el.getAttribute && el.getAttribute('data-pc-idx') || '')
      });
    }
    return out;
  }
  function q(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } }
  var quantity = q('select, [id*="quant" i], [name*="quant" i], [id*="qty" i], [name*="qty" i], [aria-label*="quantity" i], [class*="quantity" i]');
  var addToCart = q('#add-to-cart-button, [name="submit.add-to-cart"], [name*="submit.add" i], input[name*="add-to-cart" i], button[id*="cart" i], form[id*="cart" i], form[action*="cart" i], [data-action*="cart" i]');
  // Steppers: buttons whose visible text / label is a bare + or - (qty increment on mobile tiles).
  var stepper = q('button, [role="button"], a').filter(function (el) {
    var t = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
    return /^[\\-+\\u2212\\u2013]$/.test(t.replace(/\\s/g, '')) || /\\b(increase|decrease)\\b/i.test(t);
  });
  // Also any element whose visible text looks like "Add to cart" / "Add to basket".
  var addText = q('button, input, a, [role="button"]').filter(function (el) {
    var t = (el.innerText || el.textContent || el.value || '').trim();
    return /add to (cart|basket)/i.test(t);
  });
  var all = pick('quantity', quantity)
    .concat(pick('addToCart', addToCart))
    .concat(pick('addToCart', addText))
    .concat(pick('stepper', stepper))
    .slice(0, 40);
  __hpEmit(RID, { requestId: RID, type: 'diag', candidates: all });
})();`;
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
  var PRICE = ${PRICE_LEAF_RE.toString()};
  var out = [];
  var idx = 0;
  function priceLeaf(el) {
    var t = (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
    if (!PRICE.test(t)) return false;
    var kids = el.querySelectorAll('*');
    for (var k = 0; k < kids.length; k++) {
      var kt = kids[k].innerText || kids[k].textContent || '';
      if (PRICE.test(kt)) return false;
    }
    return true;
  }
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
      if (!interactive(el) && !priceLeaf(el)) continue;
      if (!visible(el)) continue;
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

/**
 * The injected actor (PROCURE_COPILOT_PLAN.md §3.5.6).
 *
 * `executeAction` is a PURE function that resolves the engine's chosen action against the
 * `data-pc-idx` handle written during serialization, then performs it: click, type (via the native
 * value setter + `input`/`change` so React/Vue-controlled inputs don't get overwritten), select, or
 * scroll. `buildActionScript` is the equivalent injectable IIFE string for the live webview.
 */
import type { ActionResult, EngineAction } from "../AutomationEngine";
import { encodeScriptMeta } from "./scriptProtocol";
import { bridgeEmitFnSource } from "./bridgeEmit";

export function executeAction(doc: Document, action: EngineAction): ActionResult {
  switch (action.type) {
    case "click":
    case "type":
    case "select": {
      const el = doc.querySelector(`[data-pc-idx="${action.idx}"]`);
      if (!el) return { ok: false, reason: "stale-handle" };
      scrollIntoView(el);
      if (action.type === "click") {
        tapElement(resolveClickTarget(el));
        return { ok: true };
      }
      if (action.type === "type") {
        setNativeValue(el, action.value, doc);
        submitField(el, doc);
        return { ok: true };
      }
      setSelectValue(el, action.value, doc);
      return { ok: true };
    }
    case "scroll": {
      const view = doc.defaultView;
      if (view && typeof view.scrollBy === "function") view.scrollBy(0, action.dy);
      return { ok: true };
    }
    case "navigate":
    case "extract":
    case "needs_human":
    case "done":
    case "fail":
      // Not DOM-executable here; the engine routes these (navigation via the bridge, etc.).
      return { ok: false, reason: `non-dom-action:${action.type}` };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return { ok: false, reason: "unknown-action" };
    }
  }
}

/**
 * The element a real finger actually lands on: the DEEPEST node at the tap point. Dispatching there
 * (instead of on the resolved `<button>`) is what makes handlers bound to an INNER child fire —
 * Hyperpure binds ADD's `onClick` to a `<span>` INSIDE the `<button>`, and React's delegated events
 * only fire that handler when the event target is the span or a descendant. A click dispatched on the
 * ancestor button bubbles UP and never passes through the child span (the "ADD clicked, cart unchanged,
 * DOM byte-identical" bug). Prefer `elementFromPoint` (real layout); fall back to the deepest first-child
 * leaf for jsdom/zero-layout, which still bubbles up through any inner handler.
 */
function deepestClickTarget(el: HTMLElement): Element {
  const doc = el.ownerDocument;
  try {
    const r = el.getBoundingClientRect?.();
    if (r && (r.width || r.height) && typeof doc?.elementFromPoint === "function") {
      const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && el.contains(hit)) return hit;
    }
  } catch {
    /* getBoundingClientRect / elementFromPoint unavailable — fall through to the leaf walk */
  }
  let node: Element = el;
  while (node.firstElementChild) node = node.firstElementChild;
  return node;
}

/**
 * The click handler is usually on the real `<button>`/`<a>`, but the serializer often hands us the
 * surrounding tile/label element — clicking that fires nothing. Resolve to the nearest interactive node
 * (self → interactive descendant → interactive ancestor) so the click lands on the actual control.
 */
function resolveClickTarget(el: Element): HTMLElement {
  const interactive = (n: Element | null): n is HTMLElement => {
    if (!n) return false;
    if (/^(button|a|input|select|textarea)$/i.test(n.tagName)) return true;
    const role = n.getAttribute("role");
    if (role === "button" || role === "link") return true;
    return n.hasAttribute("onclick");
  };
  if (interactive(el)) return el as HTMLElement;
  const inner = el.querySelector?.(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [onclick]',
  );
  if (inner) return inner as HTMLElement;
  let p: Element | null = el.parentElement;
  while (p && p.tagName !== "BODY") {
    if (interactive(p)) return p as HTMLElement;
    p = p.parentElement;
  }
  return el as HTMLElement;
}

/**
 * Tap an element the way a finger does on a touch device: a touchstart→touchend sequence in addition to
 * the native click. Hyperpure's mobile SPA binds its ADD-to-cart handler to touch (tap) events, so a bare
 * `.click()` was a silent no-op (the "ADD clicked, cart unchanged, DOM byte-identical" bug). Kept in sync
 * with the live `buildActionScript` robustClick so the tested pure path and the on-device path behave the
 * same. Touch event constructors are best-effort (jsdom lacks `Touch`/`TouchEvent`) — they degrade to a
 * generic bubbling Event so a handler bound to `touchstart`/`touchend` still fires.
 */
function tapElement(el: HTMLElement): void {
  // Dispatch on the innermost node at the tap point, not the resolved button: a handler bound to an
  // inner child (Hyperpure's ADD onClick lives on a <span> inside the <button>) only fires when the
  // event bubbles UP through it, which requires the event target to be that child or a descendant.
  const target = deepestClickTarget(el);
  const win = el.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
  for (const type of ["touchstart", "touchend"]) {
    try {
      const TouchEventCtor = (win as unknown as { TouchEvent?: typeof TouchEvent })?.TouchEvent;
      const ev = TouchEventCtor
        ? new TouchEventCtor(type, { bubbles: true, cancelable: true })
        : new Event(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
    } catch {
      try {
        target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      } catch {
        /* environment without Event — nothing more to do */
      }
    }
  }
  try {
    (target as HTMLElement).click?.();
  } catch {
    /* click unavailable — the touch sequence above is the fallback */
  }
}

function scrollIntoView(el: Element): void {
  const fn = (el as HTMLElement).scrollIntoView;
  if (typeof fn === "function") {
    try {
      (el as HTMLElement).scrollIntoView({ block: "center" });
    } catch {
      /* jsdom may not fully implement scrollIntoView */
    }
  }
}

function setNativeValue(el: Element, value: string, doc: Document): void {
  const proto = Object.getPrototypeOf(el) as object | null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
  if (desc && typeof desc.set === "function") {
    desc.set.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
  dispatch(el, "input", doc);
  dispatch(el, "change", doc);
}

/**
 * Submit a just-typed search field. Sites navigate to results on Enter or form submit, not on the
 * `input` event alone — without this, typing a query leaves the page on the homepage and the read finds
 * nothing. Best-effort and guarded: dispatch an Enter key sequence, then submit the enclosing form.
 */
function submitField(el: Element, doc: Document): void {
  const view = doc.defaultView;
  try {
    const KbCtor = view && (view as unknown as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent;
    if (KbCtor) {
      for (const type of ["keydown", "keypress", "keyup"]) {
        el.dispatchEvent(
          new KbCtor(type, { bubbles: true, key: "Enter", code: "Enter" } as KeyboardEventInit),
        );
      }
    }
  } catch {
    /* KeyboardEvent unavailable (jsdom) — fall through to form submit */
  }
  try {
    const form =
      (el as HTMLInputElement).form ??
      (typeof el.closest === "function" ? el.closest("form") : null);
    if (form) {
      if (typeof (form as HTMLFormElement).requestSubmit === "function") {
        (form as HTMLFormElement).requestSubmit();
      } else if (typeof (form as HTMLFormElement).submit === "function") {
        (form as HTMLFormElement).submit();
      }
    }
  } catch {
    /* jsdom does not implement form submission navigation; safe to ignore */
  }
}

function setSelectValue(el: Element, value: string, doc: Document): void {
  (el as HTMLSelectElement).value = value;
  dispatch(el, "change", doc);
}

function dispatch(el: Element, type: string, doc: Document): void {
  const view = doc.defaultView;
  const EventCtor: typeof Event = view && view.Event ? view.Event : Event;
  el.dispatchEvent(new EventCtor(type, { bubbles: true }));
}

/**
 * The injectable actor string posted back over the Capgo bridge as `{ type: 'action', ok, reason }`.
 * Never executed in tests (the MockBridge runs `executeAction` instead, keyed off the metadata).
 */
export function buildActionScript(requestId: string, action: EngineAction): string {
  const meta = encodeScriptMeta({ kind: "action", requestId, action });
  return `${meta}
(function () {
  ${bridgeEmitFnSource()}
  var RID = ${JSON.stringify(requestId)};
  var a = ${JSON.stringify(action)};
  function post(r) {
    __hpEmit(RID, { requestId: RID, type: 'action', ok: !!r.ok, reason: r.reason || null });
  }
  function isInteractive(n) {
    if (!n || n.nodeType !== 1) return false;
    if (/^(button|a|input|select|textarea)$/i.test(n.tagName)) return true;
    var role = n.getAttribute && n.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (n.hasAttribute && n.hasAttribute('onclick')) return true;
    if (n.tabIndex != null && n.tabIndex >= 0) return true;
    return false;
  }
  // Hyperpure (and most React SPAs) attach the click handler to the real <button>; the serializer often
  // captures the surrounding tile/label, so el.click() fired on the wrong node and the add silently no-op'd
  // (the "ADD clicked, cart unchanged" bug). Resolve to the nearest interactive node before clicking.
  function resolveTarget(n) {
    if (isInteractive(n)) return n;
    if (n.querySelector) {
      var inner = n.querySelector('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [onclick]');
      if (inner) return inner;
    }
    var p = n.parentElement;
    while (p && p !== document.body) {
      if (isInteractive(p)) return p;
      p = p.parentElement;
    }
    return n;
  }
  // The DEEPEST node at the tap point — what a real finger hits. Hyperpure binds ADD's onClick to a
  // <span> INSIDE the <button>; React's delegated events only fire that handler when the target is the
  // span or a descendant, so a gesture dispatched on the ancestor button bubbles up and never triggers
  // it (the "ADD clicked, cart unchanged, DOM byte-identical" no-op). elementFromPoint gives the inner
  // span; the leaf-walk is the fallback when layout is unavailable.
  function deepestAt(t) {
    try {
      var r = t.getBoundingClientRect && t.getBoundingClientRect();
      if (r && (r.width || r.height) && document.elementFromPoint) {
        var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && t.contains(hit)) return hit;
      }
    } catch (eD) {}
    var n = t;
    while (n.firstElementChild) n = n.firstElementChild;
    return n;
  }
  function robustClick(node) {
    var t = resolveTarget(node);
    try { if (t.scrollIntoView) t.scrollIntoView({ block: 'center' }); } catch (e0) {}
    var target = deepestAt(t);
    var r = (target.getBoundingClientRect && target.getBoundingClientRect()) || { left: 0, top: 0, width: 0, height: 0 };
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var base = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, button: 0 };
    try { if (t.focus) t.focus(); } catch (e1) {}
    // Hyperpure is a TOUCH-optimized mobile SPA: its ADD handler is bound to touch (tap) events, so a
    // pointer+mouse+click gesture alone was a silent no-op (the "ADD clicked, cart unchanged, DOM byte
    // identical" bug). Fire a real touch tap (touchstart→touchend) in addition to pointer/mouse/click so
    // whichever event family the handler listens on reacts.
    function fireTouch(type) {
      try {
        var touch = (typeof Touch === 'function')
          ? new Touch({ identifier: 1, target: target, clientX: cx, clientY: cy, pageX: cx, pageY: cy, radiusX: 2, radiusY: 2, force: 1 })
          : null;
        var list = touch ? [touch] : [];
        var te = new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, view: window,
          touches: type === 'touchend' ? [] : list,
          targetTouches: type === 'touchend' ? [] : list,
          changedTouches: list });
        target.dispatchEvent(te);
        return true;
      } catch (eT) { return false; }
    }
    // Full tap order on touch devices: pointerdown → touchstart → touchend → pointerup → mousedown → mouseup → click.
    var gesture = [['pointerover', 1], ['pointerenter', 1], ['pointerdown', 1]];
    var tail = [['pointerup', 1], ['mousedown', 0], ['mouseup', 0]];
    function fire(list) {
      list.forEach(function (g) {
        try {
          var isPtr = g[1] === 1;
          var Ctor = isPtr && window.PointerEvent ? PointerEvent : MouseEvent;
          var opts = isPtr ? Object.assign({ pointerId: 1, pointerType: 'touch', isPrimary: true }, base) : base;
          target.dispatchEvent(new Ctor(g[0], opts));
        } catch (e2) {}
      });
    }
    fire(gesture);
    fireTouch('touchstart');
    fireTouch('touchend');
    fire(tail);
    try { if (typeof target.click === 'function') target.click(); else target.dispatchEvent(new MouseEvent('click', base)); } catch (e3) {}
  }
  try {
    if (a.type === 'click' || a.type === 'type' || a.type === 'select') {
      var el = document.querySelector('[data-pc-idx="' + a.idx + '"]');
      if (!el) { post({ ok: false, reason: 'stale-handle' }); return; }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      if (a.type === 'click') {
        robustClick(el);
      } else if (a.type === 'type') {
        var proto = Object.getPrototypeOf(el);
        var d = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) { d.set.call(el, a.value); } else { el.value = a.value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Submit the query: sites navigate to results on Enter / form submit, not on 'input' alone.
        try {
          ['keydown','keypress','keyup'].forEach(function (t) {
            el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
          });
        } catch (e1) {}
        try {
          var form = el.form || (el.closest ? el.closest('form') : null);
          if (form) { if (form.requestSubmit) form.requestSubmit(); else if (form.submit) form.submit(); }
        } catch (e2) {}
      } else {
        el.value = a.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      post({ ok: true });
    } else if (a.type === 'scroll') {
      window.scrollBy(0, a.dy);
      post({ ok: true });
    } else {
      post({ ok: false, reason: 'non-dom-action:' + a.type });
    }
  } catch (e) {
    post({ ok: false, reason: String((e && e.message) || e) });
  }
})();`;
}

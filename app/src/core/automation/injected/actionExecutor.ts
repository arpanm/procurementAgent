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
        (el as HTMLElement).click();
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
  try {
    if (a.type === 'click' || a.type === 'type' || a.type === 'select') {
      var el = document.querySelector('[data-pc-idx="' + a.idx + '"]');
      if (!el) { post({ ok: false, reason: 'stale-handle' }); return; }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      if (a.type === 'click') {
        el.click();
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActionScript, executeAction } from "./actionExecutor";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("executeAction", () => {
  it("types into an input via the native setter and dispatches input/change", () => {
    document.body.innerHTML = `<input data-pc-idx="0" />`;
    const input = document.querySelector<HTMLInputElement>('[data-pc-idx="0"]')!;
    const onInput = vi.fn();
    const onChange = vi.fn();
    input.addEventListener("input", onInput);
    input.addEventListener("change", onChange);

    const result = executeAction(document, { type: "type", idx: 0, value: "onion" });

    expect(result.ok).toBe(true);
    expect(input.value).toBe("onion");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clicks an element, triggering its handler", () => {
    document.body.innerHTML = `<button data-pc-idx="1">Add</button>`;
    const button = document.querySelector<HTMLButtonElement>('[data-pc-idx="1"]')!;
    const onClick = vi.fn();
    button.addEventListener("click", onClick);

    const result = executeAction(document, { type: "click", idx: 1 });

    expect(result.ok).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("fires touch events so a tap-only handler (Hyperpure ADD) triggers", () => {
    // Hyperpure's mobile SPA binds ADD-to-cart to touchstart/touchend, not click.
    // A bare .click() was a silent no-op; the tap path must dispatch touch events.
    document.body.innerHTML = `<button data-pc-idx="1">ADD +</button>`;
    const button = document.querySelector<HTMLButtonElement>('[data-pc-idx="1"]')!;
    const onTouchStart = vi.fn();
    const onTouchEnd = vi.fn();
    button.addEventListener("touchstart", onTouchStart);
    button.addEventListener("touchend", onTouchEnd);

    const result = executeAction(document, { type: "click", idx: 1 });

    expect(result.ok).toBe(true);
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(onTouchEnd).toHaveBeenCalledTimes(1);
  });

  it("resolves the click to the nested interactive control when handed a tile", () => {
    // The serializer often hands us the surrounding tile, not the real button.
    document.body.innerHTML = `
      <div data-pc-idx="1" class="tile">
        <span>Onion</span>
        <button class="add">ADD +</button>
      </div>`;
    const innerButton = document.querySelector<HTMLButtonElement>(".add")!;
    const onTap = vi.fn();
    innerButton.addEventListener("touchstart", onTap);
    innerButton.addEventListener("click", onTap);

    const result = executeAction(document, { type: "click", idx: 1 });

    expect(result.ok).toBe(true);
    expect(onTap).toHaveBeenCalled();
  });

  it("fires a handler bound to an INNER child of the resolved button (Hyperpure ADD)", () => {
    // Hyperpure's real ADD: the onClick sits on a <span> INSIDE the <button>, not the button. A click
    // dispatched on the button bubbles UP and never reaches the child span, so the add silently no-op'd.
    // The tap must land on the deepest node so the event bubbles up THROUGH the handler span.
    document.body.innerHTML = `
      <button data-pc-idx="1" class="addBtn" role="button">
        <span class="handler"><span class="label">ADD</span><span class="icon">+</span></span>
      </button>`;
    const handlerSpan = document.querySelector<HTMLSpanElement>(".handler")!;
    const button = document.querySelector<HTMLButtonElement>('[data-pc-idx="1"]')!;
    const onHandler = vi.fn();
    handlerSpan.addEventListener("click", onHandler);
    const onButton = vi.fn();
    // The button itself has no add handler — a correct tap still bubbles through it, but the proof is
    // that the child handler fired.
    button.addEventListener("click", onButton);

    const result = executeAction(document, { type: "click", idx: 1 });

    expect(result.ok).toBe(true);
    expect(onHandler).toHaveBeenCalledTimes(1);
  });

  it("selects an option and dispatches change", () => {
    document.body.innerHTML = `
      <select data-pc-idx="2">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>`;
    const select = document.querySelector<HTMLSelectElement>('[data-pc-idx="2"]')!;
    const onChange = vi.fn();
    select.addEventListener("change", onChange);

    const result = executeAction(document, { type: "select", idx: 2, value: "b" });

    expect(result.ok).toBe(true);
    expect(select.value).toBe("b");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("returns {ok:false, reason:'stale-handle'} for a missing idx", () => {
    document.body.innerHTML = `<button data-pc-idx="0">A</button>`;
    const result = executeAction(document, { type: "click", idx: 99 });
    expect(result).toEqual({ ok: false, reason: "stale-handle" });
  });

  it("rejects non-DOM actions", () => {
    const result = executeAction(document, { type: "done" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("non-dom-action");
  });
});

// The on-device path is the IIFE string from buildActionScript (not executeAction). It was previously
// untested, which is why the touch-tap regression shipped. These tests EVAL the real injected string in
// jsdom (with TouchEvent polyfilled, since jsdom lacks it) to prove the device code resolves the target
// and fires a touch tap on Hyperpure's touch-bound ADD button.
describe("buildActionScript (live injected string)", () => {
  function runScript(action: Parameters<typeof buildActionScript>[1]): void {
    const code = buildActionScript("rid-test", action);
    // eslint-disable-next-line no-new-func -- intentionally executing the injected string under test
    new Function(code)();
  }

  function withTouchEvent(run: () => void): void {
    class FakeTouch {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    }
    class FakeTouchEvent extends Event {
      constructor(type: string, init: EventInit & Record<string, unknown> = {}) {
        super(type, init);
        // Only copy touch-specific props; bubbles/cancelable/composed/view are read-only Event getters.
        for (const k of ["touches", "targetTouches", "changedTouches"]) {
          if (k in init) {
            try {
              (this as unknown as Record<string, unknown>)[k] = init[k];
            } catch {
              /* read-only in some envs */
            }
          }
        }
      }
    }
    const g = globalThis as unknown as Record<string, unknown>;
    const prevTouch = g.Touch;
    const prevTouchEvent = g.TouchEvent;
    g.Touch = FakeTouch;
    g.TouchEvent = FakeTouchEvent;
    try {
      run();
    } finally {
      g.Touch = prevTouch;
      g.TouchEvent = prevTouchEvent;
    }
  }

  it("fires touchstart/touchend on the touch-bound ADD button", () => {
    document.body.innerHTML = `<button data-pc-idx="3">ADD +</button>`;
    const button = document.querySelector<HTMLButtonElement>('[data-pc-idx="3"]')!;
    const onTouchStart = vi.fn();
    const onTouchEnd = vi.fn();
    const onClick = vi.fn();
    button.addEventListener("touchstart", onTouchStart);
    button.addEventListener("touchend", onTouchEnd);
    button.addEventListener("click", onClick);

    withTouchEvent(() => runScript({ type: "click", idx: 3 }));

    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(onTouchEnd).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("resolves a wrapping tile to the inner button before tapping", () => {
    document.body.innerHTML = `
      <div data-pc-idx="4" class="tile">
        <span>Onion 5kg</span>
        <button class="add">ADD +</button>
      </div>`;
    const innerButton = document.querySelector<HTMLButtonElement>(".add")!;
    const onTouchStart = vi.fn();
    innerButton.addEventListener("touchstart", onTouchStart);

    withTouchEvent(() => runScript({ type: "click", idx: 4 }));

    expect(onTouchStart).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "./actionExecutor";

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

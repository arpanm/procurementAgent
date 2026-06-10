import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

interface Counter {
  readonly n: number;
}

describe("createStore", () => {
  it("returns the seeded snapshot from getState", () => {
    const store = createStore<Counter>({ n: 1 });
    expect(store.getState()).toEqual({ n: 1 });
  });

  it("notifies subscribers when state changes and returns the new snapshot", () => {
    const store = createStore<Counter>({ n: 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState((s) => ({ n: s.n + 1 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ n: 1 });
  });

  it("does NOT notify when the updater returns the same reference (no-op)", () => {
    const store = createStore<Counter>({ n: 5 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState((s) => s);

    expect(listener).not.toHaveBeenCalled();
    expect(store.getState()).toEqual({ n: 5 });
  });

  it("stops notifying after unsubscribe", () => {
    const store = createStore<Counter>({ n: 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setState((s) => ({ n: s.n + 1 }));
    unsubscribe();
    store.setState((s) => ({ n: s.n + 1 }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ n: 2 });
  });

  it("supports multiple independent subscribers", () => {
    const store = createStore<Counter>({ n: 0 });
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);

    store.setState((s) => ({ n: s.n + 1 }));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

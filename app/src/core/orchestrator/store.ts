/**
 * A tiny, framework-agnostic observable store (PROCURE_COPILOT_PLAN.md §3.6.4).
 *
 * The orchestrator owns a single store and is its SINGLE WRITER; the React screens subscribe to it
 * read-only via {@link https://react.dev/reference/react/useSyncExternalStore useSyncExternalStore}.
 * The shape deliberately matches that hook: `subscribe(cb) => unsubscribe` and `getState()` is a
 * stable snapshot getter (it returns the same reference until {@link Store.setState} produces a new
 * one, so `useSyncExternalStore` never tears or loops).
 */

/** Read-only view of the store, suitable for `useSyncExternalStore`. */
export interface ReadableStore<T> {
  /** Returns the current immutable snapshot. Stable reference until the next change. */
  getState(): T;
  /** Subscribe to changes; the callback takes no args (read fresh via {@link getState}). */
  subscribe(listener: () => void): () => void;
}

export interface Store<T> extends ReadableStore<T> {
  /**
   * Apply a pure updater to produce the next snapshot. If the updater returns the *same* reference
   * (a no-op), subscribers are NOT notified — this keeps `useSyncExternalStore` quiet on no-ops.
   */
  setState(updater: (previous: T) => T): void;
}

/**
 * Create an observable store seeded with `initial`. The returned methods are pre-bound closures, so
 * they can be passed directly to `useSyncExternalStore` without losing `this`.
 */
export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  const getState = (): T => state;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const setState = (updater: (previous: T) => T): void => {
    const next = updater(state);
    if (Object.is(next, state)) {
      return;
    }
    state = next;
    // Snapshot the listener set so an unsubscribe during notification can't skip a sibling.
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return { getState, subscribe, setState };
}

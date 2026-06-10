/**
 * Idempotency for order placement (PROCURE_COPILOT_PLAN.md §3.5.10). A mid-checkout network drop must
 * never double-order. Every `placeOrder` carries a key derived from the platform + the approved
 * allocation, so a retried attempt with the same key resolves to the SAME stored result instead of
 * placing again.
 *
 * The guard is backed by the on-device {@link SecureStore} (durable across cold-starts) and an
 * in-process in-flight map (so two concurrent callers with the same key share one placement).
 */
import type { SecureStore } from "../secure/SecureStore";
import type { PlatformAllocation, PlatformId } from "../domain/types";

/**
 * Small, dependency-free deterministic string hash (cyrb53). Used to fold the allocation into a short
 * stable token — not for security, only for a compact deterministic key.
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return out.toString(16).padStart(14, "0");
}

/**
 * Build a deterministic idempotency key for placing this platform's allocation. The same allocation
 * always yields the same key, so a retry (same plan, same platform) is recognised as the same order.
 */
export function newIdempotencyKey(
  platform: PlatformId,
  allocation: PlatformAllocation,
): string {
  const canonicalLines = allocation.lines
    .map((l) => `${l.skuId}#${l.qty}#${l.unitPricePaise}`)
    .sort()
    .join("|");
  const payload = `${platform}::${allocation.totalPaise}::${canonicalLines}`;
  return `${platform}-${cyrb53(payload)}`;
}

/**
 * A guard that runs `fn` at most once per key and memoises its result on-device. A second call with
 * the same key returns the stored result without re-invoking `fn` — the core anti-double-order rule.
 */
export class IdempotencyStore {
  /** In-flight placements by key, so concurrent callers join the same promise (no double-run). */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: SecureStore,
    private readonly prefix = "idem:",
  ) {}

  private storageKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** True if a result for this key has already been committed durably. */
  async has(key: string): Promise<boolean> {
    return (await this.store.get(this.storageKey(key))) !== null;
  }

  /**
   * Run `fn` under the idempotency guard. If a result already exists for `key`, return it without
   * invoking `fn`. Otherwise invoke `fn` exactly once, persist its result, and return it. Concurrent
   * callers with the same key share the single in-flight promise.
   */
  async withIdempotency<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const storageKey = this.storageKey(key);

    const existing = await this.store.get(storageKey);
    if (existing !== null) {
      return JSON.parse(existing) as T;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = (async (): Promise<T> => {
      const result = await fn();
      await this.store.set(storageKey, JSON.stringify(result));
      return result;
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }
}

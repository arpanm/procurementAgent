import { describe, expect, it, vi } from "vitest";
import { InMemorySecureStore } from "../secure/SecureStore";
import type { PlatformAllocation } from "../domain/types";
import { IdempotencyStore, newIdempotencyKey } from "./idempotency";

function allocation(qty = 5): PlatformAllocation {
  return {
    platform: "hyperpure",
    lines: [
      {
        canonicalItemId: "potato",
        itemName: "potato",
        platform: "hyperpure",
        skuId: "hp-potato",
        qty,
        unitPricePaise: 1000,
        lineTotalPaise: qty * 1000,
        reason: "x",
      },
    ],
    subtotalPaise: qty * 1000,
    deliveryFeePaise: 0,
    totalPaise: qty * 1000,
    meetsMov: true,
    payableOnCredit: true,
  };
}

describe("newIdempotencyKey", () => {
  it("is deterministic for the same platform + allocation", () => {
    expect(newIdempotencyKey("hyperpure", allocation())).toBe(
      newIdempotencyKey("hyperpure", allocation()),
    );
  });

  it("differs when the allocation differs", () => {
    expect(newIdempotencyKey("hyperpure", allocation(5))).not.toBe(
      newIdempotencyKey("hyperpure", allocation(6)),
    );
  });

  it("differs by platform", () => {
    const a = allocation();
    expect(newIdempotencyKey("hyperpure", a)).not.toBe(
      newIdempotencyKey("amazon", { ...a, platform: "amazon" }),
    );
  });

  it("is order-independent across lines", () => {
    const a = allocation();
    const reordered: PlatformAllocation = {
      ...a,
      lines: [
        ...a.lines,
        {
          canonicalItemId: "onion",
          itemName: "onion",
          platform: "hyperpure",
          skuId: "hp-onion",
          qty: 2,
          unitPricePaise: 800,
          lineTotalPaise: 1600,
          reason: "y",
        },
      ],
    };
    const swapped: PlatformAllocation = {
      ...reordered,
      lines: [reordered.lines[1], reordered.lines[0]],
    };
    expect(newIdempotencyKey("hyperpure", reordered)).toBe(
      newIdempotencyKey("hyperpure", swapped),
    );
  });
});

describe("IdempotencyStore", () => {
  it("runs fn once and returns the cached result on a second call with the same key", async () => {
    const guard = new IdempotencyStore(new InMemorySecureStore());
    const fn = vi.fn(async () => ({ orderRef: "A", n: 1 }));

    const first = await guard.withIdempotency("k", fn);
    const second = await guard.withIdempotency("k", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("runs fn again for a different key", async () => {
    const guard = new IdempotencyStore(new InMemorySecureStore());
    const fn = vi.fn(async () => ({ ok: true }));
    await guard.withIdempotency("k1", fn);
    await guard.withIdempotency("k2", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("shares a single in-flight run across concurrent callers with the same key", async () => {
    const guard = new IdempotencyStore(new InMemorySecureStore());
    let resolve!: (v: { ref: string }) => void;
    const pending = new Promise<{ ref: string }>((r) => {
      resolve = r;
    });
    const fn = vi.fn(() => pending);

    const a = guard.withIdempotency("k", fn);
    const b = guard.withIdempotency("k", fn);
    resolve({ ref: "X" });

    expect(await a).toEqual({ ref: "X" });
    expect(await b).toEqual({ ref: "X" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("persists the result to the secure store (durable across cold-start)", async () => {
    const store = new InMemorySecureStore();
    const guard = new IdempotencyStore(store);
    await guard.withIdempotency("k", async () => ({ orderRef: "Z" }));

    expect(await guard.has("k")).toBe(true);

    // A fresh guard over the same store still recognises the key.
    const reborn = new IdempotencyStore(store);
    const fn = vi.fn(async () => ({ orderRef: "DIFFERENT" }));
    const result = await reborn.withIdempotency("k", fn);
    expect(result).toEqual({ orderRef: "Z" });
    expect(fn).not.toHaveBeenCalled();
  });
});

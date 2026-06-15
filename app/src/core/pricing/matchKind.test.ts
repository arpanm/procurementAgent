import { describe, expect, it } from "vitest";
import type { Quote, RequestedItem } from "../domain/types";
import { chooseQuote, matchKind } from "./matchKind";

function item(partial: Partial<RequestedItem> & { name: string }): RequestedItem {
  return {
    raw: partial.raw ?? partial.name,
    name: partial.name,
    qty: partial.qty ?? 1,
    unit: partial.unit ?? "piece",
    brand: partial.brand,
    variant: partial.variant,
    packSize: partial.packSize,
    notes: partial.notes,
  };
}

function quote(partial: Partial<Quote> & { skuId: string; title: string; pricePaise: number }): Quote {
  return {
    platform: partial.platform ?? "hyperpure",
    skuId: partial.skuId,
    canonicalItemId: partial.canonicalItemId ?? "paneer",
    title: partial.title,
    pricePaise: partial.pricePaise,
    packSize: partial.packSize,
    inStock: partial.inStock ?? true,
    readAt: partial.readAt ?? "2026-01-01T00:00:00Z",
  };
}

describe("matchKind", () => {
  it("is exact when brand and pack size both match", () => {
    const it1 = item({ name: "paneer", brand: "Milky Mist", packSize: "500 g" });
    const q = quote({ skuId: "mm-500", title: "Milky Mist - Paneer, 500 g", pricePaise: 23700 });
    expect(matchKind(it1, q)).toBe("exact");
  });

  it("is nearby when the brand differs", () => {
    const it1 = item({ name: "paneer", brand: "Milky Mist", packSize: "500 g" });
    const q = quote({ skuId: "amul-500", title: "Amul Paneer, 500 g", pricePaise: 21000 });
    expect(matchKind(it1, q)).toBe("nearby");
  });

  it("is nearby when the pack size differs", () => {
    const it1 = item({ name: "paneer", brand: "Milky Mist", packSize: "500 g" });
    const q = quote({ skuId: "mm-1kg", title: "Milky Mist - Paneer, 1 Kg", pricePaise: 42000 });
    expect(matchKind(it1, q)).toBe("nearby");
  });

  it("treats a bare request (no brand, no size) as exact for the same item", () => {
    const it1 = item({ name: "onion", unit: "kg" });
    const q = quote({ skuId: "onion-5kg", title: "Onion (Big), 5 Kg", pricePaise: 30000 });
    expect(matchKind(it1, q)).toBe("exact");
  });

  it("reads the requested size from the raw text when packSize is absent", () => {
    const it1 = item({ name: "paneer", raw: "milky mist paneer 500 gm", brand: "Milky Mist" });
    const exact = quote({ skuId: "mm-500", title: "Milky Mist Paneer 500 g", pricePaise: 23700 });
    const near = quote({ skuId: "mm-1kg", title: "Milky Mist Paneer 1 Kg", pricePaise: 42000 });
    expect(matchKind(it1, exact)).toBe("exact");
    expect(matchKind(it1, near)).toBe("nearby");
  });
});

describe("chooseQuote", () => {
  it("auto-picks the cheapest per-kg among EXACT matches, ignoring cheaper nearby SKUs", () => {
    const it1 = item({ name: "paneer", brand: "Milky Mist", packSize: "500 g" });
    const candidates = [
      quote({ skuId: "amul-500", title: "Amul Paneer 500 g", pricePaise: 18000 }), // cheaper, nearby
      quote({ skuId: "mm-500-a", title: "Milky Mist Paneer 500 g", pricePaise: 24000 }),
      quote({ skuId: "mm-500-b", title: "Milky Mist Paneer 500 g (pack)", pricePaise: 22000 }), // exact, cheapest
    ];
    const chosen = chooseQuote(it1, candidates);
    expect(chosen?.skuId).toBe("mm-500-b");
    expect(chosen?.matchKind).toBe("exact");
  });

  it("falls back to the cheapest per-kg NEARBY when there is no exact match", () => {
    const it1 = item({ name: "paneer", brand: "Milky Mist", packSize: "500 g" });
    const candidates = [
      quote({ skuId: "mm-1kg", title: "Milky Mist Paneer 1 Kg", pricePaise: 42000 }), // ₹420/kg
      quote({ skuId: "amul-1kg", title: "Amul Paneer 1 Kg", pricePaise: 40000 }), // ₹400/kg, cheapest /kg
    ];
    const chosen = chooseQuote(it1, candidates);
    expect(chosen?.skuId).toBe("amul-1kg");
    expect(chosen?.matchKind).toBe("nearby");
  });

  it("prefers in-stock candidates over cheaper out-of-stock ones", () => {
    const it1 = item({ name: "onion", unit: "kg" });
    const candidates = [
      quote({ skuId: "oos", title: "Onion 5 Kg", pricePaise: 25000, inStock: false }),
      quote({ skuId: "ok", title: "Onion 5 Kg", pricePaise: 30000, inStock: true }),
    ];
    expect(chooseQuote(it1, candidates)?.skuId).toBe("ok");
  });

  it("returns undefined for an empty candidate list", () => {
    expect(chooseQuote(item({ name: "x" }), [])).toBeUndefined();
  });
});

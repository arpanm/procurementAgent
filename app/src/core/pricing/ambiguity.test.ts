import { describe, expect, it } from "vitest";
import type { Quote } from "../domain/types";
import { isAmbiguousItem, productCore } from "./ambiguity";

function quote(title: string, opts: Partial<Quote> = {}): Quote {
  return {
    platform: "hyperpure",
    skuId: opts.skuId ?? title.toLowerCase().replace(/\s+/g, "-"),
    canonicalItemId: "x",
    title,
    pricePaise: opts.pricePaise ?? 10000,
    inStock: opts.inStock ?? true,
    readAt: "2026-01-01T00:00:00.000Z",
    ...opts,
  };
}

describe("productCore", () => {
  it("strips sizes/packs so the same product collapses regardless of pack size", () => {
    expect(productCore("Milky Mist Paneer, 1 Kg")).toBe(productCore("Milky Mist Paneer 500 g"));
  });

  it("keeps distinct products distinct", () => {
    expect(productCore("ITC - Crunchy Chicken Nugget, 1 Kg")).not.toBe(
      productCore("Chicken Curry Cut 1 Kg"),
    );
  });

  it("drops punctuation, stopwords and multipack phrasing", () => {
    expect(productCore("Onion - Fresh (Pack of 6) 2 x 500 g")).toBe("onion");
  });
});

describe("isAmbiguousItem", () => {
  it("flags different products for the same generic term (chicken cuts)", () => {
    const candidates = [
      quote("ITC - Crunchy Chicken Nugget, 1 Kg"),
      quote("Chicken Curry Cut 1 Kg"),
      quote("Whole Chicken 1 Kg"),
    ];
    expect(isAmbiguousItem(candidates)).toBe(true);
  });

  it("does NOT flag mere pack-size variants of one product", () => {
    const candidates = [
      quote("Milky Mist Paneer 1 Kg"),
      quote("Milky Mist Paneer 500 g"),
      quote("Milky Mist Paneer 200 g"),
    ];
    expect(isAmbiguousItem(candidates)).toBe(false);
  });

  it("needs at least two candidates", () => {
    expect(isAmbiguousItem([quote("Whole Chicken 1 Kg")])).toBe(false);
    expect(isAmbiguousItem([])).toBe(false);
  });

  it("ignores out-of-stock noise when in-stock candidates agree", () => {
    const candidates = [
      quote("Milky Mist Paneer 1 Kg", { inStock: true }),
      quote("Milky Mist Paneer 500 g", { inStock: true }),
      quote("Amul Cheese Block 1 Kg", { inStock: false }),
    ];
    expect(isAmbiguousItem(candidates)).toBe(false);
  });
});

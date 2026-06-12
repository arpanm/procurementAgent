import { describe, expect, it } from "vitest";
import type { Quote } from "../domain/types";
import { defaultPlatformPins } from "./defaultSelection";

function quote(partial: Partial<Quote> & Pick<Quote, "platform" | "canonicalItemId" | "pricePaise">): Quote {
  return {
    skuId: `${partial.platform}-${partial.canonicalItemId}`,
    title: "Item",
    inStock: true,
    readAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as Quote;
}

describe("defaultPlatformPins", () => {
  it("picks the platform with the lowest price PER UNIT, not the lowest pack price", () => {
    // Hyperpure: 1 Kg @ ₹399 → ₹399/kg. Amazon: 500 g @ ₹99 → ₹198/kg (cheaper per kg).
    const pins = defaultPlatformPins([
      quote({ platform: "hyperpure", canonicalItemId: "paneer", pricePaise: 39900, packSize: "1 Kg" }),
      quote({ platform: "amazon", canonicalItemId: "paneer", pricePaise: 9900, packSize: "500 g" }),
    ]);
    expect(pins).toEqual({ paneer: "amazon" });
  });

  it("prefers an in-stock quote over a cheaper out-of-stock one", () => {
    const pins = defaultPlatformPins([
      quote({ platform: "hyperpure", canonicalItemId: "paneer", pricePaise: 9900, packSize: "1 Kg", inStock: false }),
      quote({ platform: "amazon", canonicalItemId: "paneer", pricePaise: 39900, packSize: "1 Kg", inStock: true }),
    ]);
    expect(pins).toEqual({ paneer: "amazon" });
  });

  it("falls back to raw price when no pack size is parseable", () => {
    const pins = defaultPlatformPins([
      quote({ platform: "hyperpure", canonicalItemId: "rice", pricePaise: 5000, title: "Loose rice" }),
      quote({ platform: "amazon", canonicalItemId: "rice", pricePaise: 4000, title: "Loose rice" }),
    ]);
    expect(pins).toEqual({ rice: "amazon" });
  });

  it("returns one pin per item across multiple items", () => {
    const pins = defaultPlatformPins([
      quote({ platform: "hyperpure", canonicalItemId: "paneer", pricePaise: 39900, packSize: "1 Kg" }),
      quote({ platform: "amazon", canonicalItemId: "paneer", pricePaise: 9900, packSize: "500 g" }),
      quote({ platform: "hyperpure", canonicalItemId: "milk", pricePaise: 6000, packSize: "1 L" }),
    ]);
    expect(pins).toEqual({ paneer: "amazon", milk: "hyperpure" });
  });
});

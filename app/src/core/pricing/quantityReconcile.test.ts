import { describe, expect, it } from "vitest";
import type { Allocation, Quote, RequestedItem } from "../domain/types";
import { packsNeeded, reconcileAllocation } from "./quantityReconcile";

const item: RequestedItem = {
  raw: "6 packets of milky mist 500 gm paneer",
  name: "paneer",
  qty: 6,
  unit: "packet",
  brand: "Milky Mist",
  packSize: "500 g",
};

function quote(platform: Quote["platform"], skuId: string, pricePaise: number, packSize: string): Quote {
  return {
    platform,
    skuId,
    canonicalItemId: "paneer",
    title: `Milky Mist Paneer ${packSize}`,
    pricePaise,
    packSize,
    inStock: true,
    readAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("packsNeeded", () => {
  it("buys 3 × 1 kg packs to cover a 6 × 500 g (= 3 kg) request", () => {
    expect(packsNeeded(item, quote("hyperpure", "hp", 39900, "1 Kg"))).toBe(3);
  });

  it("buys 6 × 500 g packs for the same 3 kg request", () => {
    expect(packsNeeded(item, quote("amazon", "az", 23700, "500 g"))).toBe(6);
  });

  it("rounds up when the total isn't a clean multiple", () => {
    // 6 × 500 g = 3 kg, packs of 800 g → ceil(3000/800) = 4
    expect(packsNeeded(item, quote("amazon", "az", 30000, "800 g"))).toBe(4);
  });

  it("keeps the requested count when pack sizes can't be reconciled (loose produce)", () => {
    const loose: RequestedItem = { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" };
    expect(packsNeeded(loose, quote("hyperpure", "hp", 5000, ""))).toBe(5);
  });
});

describe("reconcileAllocation", () => {
  it("recomputes line qty + totals to the chosen platform's pack size", () => {
    const alloc: Allocation = {
      perPlatform: [
        {
          platform: "hyperpure",
          lines: [
            {
              canonicalItemId: "paneer",
              itemName: "paneer",
              platform: "hyperpure",
              skuId: "hp",
              qty: 6, // raw (wrong) count carried from the request
              unitPricePaise: 39900,
              lineTotalPaise: 6 * 39900,
              reason: "best value",
            },
          ],
          subtotalPaise: 6 * 39900,
          deliveryFeePaise: 0,
          totalPaise: 6 * 39900,
          meetsMov: true,
          payableOnCredit: true,
        },
      ],
      grandTotalPaise: 6 * 39900,
      singlePlatformBaselinePaise: 6 * 39900,
      savingPaise: 0,
      unfulfilled: [],
    };

    const quotes = [
      quote("hyperpure", "hp", 39900, "1 Kg"),
      quote("amazon", "az", 23700, "500 g"),
    ];
    const out = reconcileAllocation(alloc, [item], quotes);

    const line = out.perPlatform[0].lines[0];
    expect(line.qty).toBe(3); // 3 × 1 kg, not 6
    expect(line.lineTotalPaise).toBe(3 * 39900);
    expect(out.perPlatform[0].subtotalPaise).toBe(3 * 39900);
    expect(out.grandTotalPaise).toBe(3 * 39900);
    // Baseline: cheapest single platform for the whole 3 kg basket.
    // Hyperpure 3 × ₹399 = ₹1197; Amazon 6 × ₹237 = ₹1422 → baseline = 119700.
    expect(out.singlePlatformBaselinePaise).toBe(119700);
  });

  it("leaves lines unchanged when no matching quote is found", () => {
    const alloc: Allocation = {
      perPlatform: [
        {
          platform: "hyperpure",
          lines: [
            {
              canonicalItemId: "unknown",
              itemName: "unknown",
              platform: "hyperpure",
              skuId: "x",
              qty: 2,
              unitPricePaise: 1000,
              lineTotalPaise: 2000,
              reason: "",
            },
          ],
          subtotalPaise: 2000,
          deliveryFeePaise: 0,
          totalPaise: 2000,
          meetsMov: true,
          payableOnCredit: true,
        },
      ],
      grandTotalPaise: 2000,
      singlePlatformBaselinePaise: 2000,
      savingPaise: 0,
      unfulfilled: [],
    };
    const out = reconcileAllocation(alloc, [item], []);
    expect(out.perPlatform[0].lines[0].qty).toBe(2);
  });
});

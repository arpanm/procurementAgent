import { describe, expect, it } from "vitest";
import type { Allocation, Quote, RequestedItem } from "../domain/types";
import { packsNeeded, reconciledPackCount, reconcileAllocation } from "./quantityReconcile";

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

  it("rounds up a non-multiple total onto a 1 kg pack platform", () => {
    // PHASE 0b lock: 5 × 500 g = 2.5 kg against 1 kg packs → ceil(2500/1000) = 3 (not 2).
    const twoAndHalf: RequestedItem = { ...item, qty: 5 };
    expect(packsNeeded(twoAndHalf, quote("hyperpure", "hp", 39900, "1 Kg"))).toBe(3);
  });

  it("keeps the requested count when the SOLD pack is loose/unparseable", () => {
    const loose: RequestedItem = { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" };
    expect(packsNeeded(loose, quote("hyperpure", "hp", 5000, ""))).toBe(5);
  });

  it("reconciles a loose weight request against a sized SKU (the '10 kg onion' bug)", () => {
    const onion: RequestedItem = { raw: "10 kg onion", name: "onion", qty: 10, unit: "kg" };
    // "Onion (Big), 10 Kg" SKU → 1 pack (NOT 10 packs = 100 kg).
    expect(packsNeeded(onion, quote("hyperpure", "big", 36400, "10 Kg"))).toBe(1);
    // "Onion (Medium), 5 Kg" SKU → 2 packs of 5 kg = 10 kg.
    expect(packsNeeded(onion, quote("hyperpure", "med", 14200, "5 Kg"))).toBe(2);
    // SKU sized from the title when packSize is absent.
    expect(packsNeeded(onion, { ...quote("hyperpure", "t", 36400, ""), title: "Onion (Big), 10 Kg" })).toBe(
      1,
    );
  });

  // ----- SPEC LOCK: the user's exact pack-count table for a 10 kg request -----
  it("computes packs = ceil(10 kg / SKU pack) across every SKU size", () => {
    const tenKg: RequestedItem = { raw: "10 kg onion", name: "onion", qty: 10, unit: "kg" };
    const table: ReadonlyArray<readonly [string, number]> = [
      ["200 g", 50],
      ["250 g", 40],
      ["500 g", 20],
      ["1 Kg", 10],
      ["2 Kg", 5],
      ["5 Kg", 2],
      ["10 Kg", 1],
    ];
    for (const [packSize, expected] of table) {
      expect(packsNeeded(tenKg, quote("hyperpure", packSize, 10000, packSize))).toBe(expected);
    }
  });

  it("treats '5 packets of 2 kg' as 10 kg total and adjusts to the SKU's pack size", () => {
    // 5 × 2 kg = 10 kg total; on a 1 kg-pack SKU that's 10 packs, on a 2 kg-pack SKU 5, on 500 g 20.
    const fivePacks: RequestedItem = {
      raw: "5 packets of 2 kg atta",
      name: "atta",
      qty: 5,
      unit: "packet",
      packSize: "2 kg",
    };
    expect(packsNeeded(fivePacks, quote("hyperpure", "1kg", 10000, "1 Kg"))).toBe(10);
    expect(packsNeeded(fivePacks, quote("hyperpure", "2kg", 20000, "2 Kg"))).toBe(5);
    expect(packsNeeded(fivePacks, quote("hyperpure", "500g", 5000, "500 g"))).toBe(20);
  });

  it("reconciles volume the same way (litres), not just weight", () => {
    const tenL: RequestedItem = { raw: "10 litre milk", name: "milk", qty: 10, unit: "l" };
    expect(packsNeeded(tenL, quote("hyperpure", "1L", 6000, "1 L"))).toBe(10);
    expect(packsNeeded(tenL, quote("hyperpure", "500ml", 3000, "500 ml"))).toBe(20);
  });

  // ----- PHASE 0b REGRESSION LOCK: pin the exact reconciliation rules pre-refactor -----

  it("buys 6 × 500 g packs for the same 3 kg request (explicit, mirrors the Amazon pack size)", () => {
    // Locking the symmetric case alongside the 1 kg case so a refactor can't silently change either.
    expect(packsNeeded(item, quote("amazon", "az", 23700, "500 g"))).toBe(6);
  });

  it("never returns 0 packs for a sub-pack request (floors at 1)", () => {
    // 1 × 500 g requested against a 1 kg pack → ceil(500/1000) = 1, not 0.
    const single: RequestedItem = { ...item, qty: 1 };
    expect(packsNeeded(single, quote("hyperpure", "hp", 39900, "1 Kg"))).toBe(1);
  });
});

describe("reconciledPackCount (the reconcile primitive)", () => {
  it("returns ceil(total / soldPack) when both sizes parse to the same dimension", () => {
    expect(reconciledPackCount(item, quote("hyperpure", "hp", 39900, "1 Kg"))).toBe(3);
    expect(reconciledPackCount(item, quote("amazon", "az", 23700, "500 g"))).toBe(6);
  });

  it("returns undefined (leave qty untouched) when the sold pack size is unparseable", () => {
    expect(reconciledPackCount(item, quote("hyperpure", "hp", 5000, ""))).toBeUndefined();
  });

  it("reconciles a loose weight request against a sized pack (qty is the total amount)", () => {
    // "5 kg potato" against 1 kg packs → 5 packs; this used to (wrongly) return undefined.
    const loose: RequestedItem = { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" };
    expect(reconciledPackCount(loose, quote("hyperpure", "hp", 5000, "1 Kg"))).toBe(5);
  });

  it("returns undefined for a loose request when the sold pack is also unparseable", () => {
    const loose: RequestedItem = { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" };
    expect(reconciledPackCount(loose, quote("hyperpure", "hp", 5000, ""))).toBeUndefined();
  });

  it("returns undefined on a dimension mismatch (weight request vs volume pack)", () => {
    // 500 g paneer can't be reconciled against a 1 L pack — different physical dimension.
    expect(reconciledPackCount(item, quote("hyperpure", "hp", 39900, "1 L"))).toBeUndefined();
  });

  it("falls back to the requested count via packsNeeded when reconciliation is impossible", () => {
    // packsNeeded === reconciledPackCount ?? max(1, qty); here that fallback is the requested 6.
    expect(reconciledPackCount(item, quote("hyperpure", "hp", 39900, "1 L"))).toBeUndefined();
    expect(packsNeeded(item, quote("hyperpure", "hp", 39900, "1 L"))).toBe(6);
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

  // ----- PHASE 0b REGRESSION LOCK: per-platform pack-count divergence in ONE allocation -----
  // This is the exact behaviour the per-platform-agent refactor must preserve: a single 6 × 500 g
  // (= 3 kg) request reconciles to DIFFERENT pack counts per platform — 3 packs where 1 kg is sold,
  // 6 packs where 500 g is sold — with the rupee rollups recomputed to match.
  it("reconciles the same request to 3 packs on a 1 kg platform and 6 packs on a 500 g platform at once", () => {
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
              reason: "1 kg packs",
            },
          ],
          subtotalPaise: 6 * 39900,
          deliveryFeePaise: 0,
          totalPaise: 6 * 39900,
          meetsMov: true,
          payableOnCredit: true,
        },
        {
          platform: "amazon",
          lines: [
            {
              canonicalItemId: "paneer",
              itemName: "paneer",
              platform: "amazon",
              skuId: "az",
              qty: 6, // already correct for a 500 g pack (3 kg / 500 g = 6) — must stay 6
              unitPricePaise: 23700,
              lineTotalPaise: 6 * 23700,
              reason: "500 g packs",
            },
          ],
          subtotalPaise: 6 * 23700,
          deliveryFeePaise: 0,
          totalPaise: 6 * 23700,
          meetsMov: true,
          payableOnCredit: true,
        },
      ],
      grandTotalPaise: 6 * 39900 + 6 * 23700,
      singlePlatformBaselinePaise: 6 * 39900,
      savingPaise: 0,
      unfulfilled: [],
    };

    const quotes = [
      quote("hyperpure", "hp", 39900, "1 Kg"),
      quote("amazon", "az", 23700, "500 g"),
    ];
    const out = reconcileAllocation(alloc, [item], quotes);

    const hp = out.perPlatform.find((p) => p.platform === "hyperpure")!;
    const az = out.perPlatform.find((p) => p.platform === "amazon")!;

    // Hyperpure (1 kg packs): 6 → 3, line + subtotal recomputed.
    expect(hp.lines[0].qty).toBe(3);
    expect(hp.lines[0].lineTotalPaise).toBe(3 * 39900);
    expect(hp.subtotalPaise).toBe(3 * 39900);

    // Amazon (500 g packs): already 6 for 3 kg, so it is left untouched.
    expect(az.lines[0].qty).toBe(6);
    expect(az.lines[0].lineTotalPaise).toBe(6 * 23700);
    expect(az.subtotalPaise).toBe(6 * 23700);

    // Grand total = both reconciled platform totals; baseline = cheapest single platform (HP @ 3 × ₹399).
    expect(out.grandTotalPaise).toBe(3 * 39900 + 6 * 23700);
    expect(out.singlePlatformBaselinePaise).toBe(3 * 39900);
    expect(out.savingPaise).toBe(3 * 39900 + 6 * 23700 - 3 * 39900);
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

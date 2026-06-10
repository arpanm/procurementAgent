import { describe, expect, it, vi } from "vitest";
import type { BackendClient, OptimizeRequest } from "../backend/BackendClient";
import type { Allocation, Quote, RequestedItem } from "../domain/types";
import { OptimizerClient, explainAllocation } from "./OptimizerClient";

const ITEMS: readonly RequestedItem[] = [
  { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" },
];

function quote(
  platform: Quote["platform"],
  skuId: string,
  canonicalItemId: string,
  extra: Partial<Quote> = {},
): Quote {
  return {
    platform,
    skuId,
    canonicalItemId,
    title: `${canonicalItemId} on ${platform}`,
    pricePaise: 1000,
    inStock: true,
    readAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const ALLOCATION: Allocation = {
  perPlatform: [
    {
      platform: "hyperpure",
      lines: [
        {
          canonicalItemId: "potato",
          itemName: "potato",
          platform: "hyperpure",
          skuId: "hp-potato",
          qty: 5,
          unitPricePaise: 1000,
          lineTotalPaise: 5000,
          reason: "cheaper on Hyperpure by ₹38",
        },
      ],
      subtotalPaise: 5000,
      deliveryFeePaise: 1500,
      totalPaise: 6500,
      meetsMov: true,
      payableOnCredit: true,
    },
  ],
  grandTotalPaise: 6500,
  singlePlatformBaselinePaise: 8800,
  savingPaise: -2300,
  unfulfilled: [],
};

function makeBackend(optimize: BackendClient["optimize"]): {
  backend: BackendClient;
  optimize: ReturnType<typeof vi.fn>;
} {
  const optimizeMock = vi.fn(optimize);
  const reject = () => Promise.reject(new Error("not used"));
  const backend: BackendClient = {
    intent: reject as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: reject as unknown as BackendClient["verify"],
    optimize: optimizeMock as unknown as BackendClient["optimize"],
    appendEvent: reject as unknown as BackendClient["appendEvent"],
    createSession: reject as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
  };
  return { backend, optimize: optimizeMock };
}

describe("OptimizerClient", () => {
  it("builds the OptimizeRequest from items + quotes and derives per-platform constraints", () => {
    const { backend } = makeBackend(async () => ALLOCATION);
    const client = new OptimizerClient(backend);
    const quotes = [
      quote("hyperpure", "hp-potato", "potato", { movPaise: 50000, deliveryFeePaise: 1500 }),
      quote("amazon", "az-potato", "potato", { movPaise: 30000, deliveryFeePaise: 4000 }),
    ];

    const req = client.buildRequest(ITEMS, quotes);

    expect(req.items).toEqual(ITEMS);
    expect(req.quotes).toHaveLength(2);
    expect(req.constraints).toEqual(
      expect.arrayContaining([
        { platform: "hyperpure", movPaise: 50000, deliveryFeePaise: 1500 },
        { platform: "amazon", movPaise: 30000, deliveryFeePaise: 4000 },
      ]),
    );
  });

  it("applies a swap pin by dropping other-platform quotes for that item", () => {
    const { backend } = makeBackend(async () => ALLOCATION);
    const client = new OptimizerClient(backend);
    const quotes = [
      quote("hyperpure", "hp-potato", "potato"),
      quote("amazon", "az-potato", "potato"),
    ];

    const req = client.buildRequest(ITEMS, quotes, { pins: { potato: "amazon" } });

    expect(req.quotes).toHaveLength(1);
    expect(req.quotes[0].platform).toBe("amazon");
  });

  it("prefers explicit constraints when provided", () => {
    const { backend } = makeBackend(async () => ALLOCATION);
    const client = new OptimizerClient(backend);
    const constraints = [{ platform: "hyperpure" as const, movPaise: 1, deliveryFeePaise: 2 }];

    const req = client.buildRequest(ITEMS, [quote("hyperpure", "hp", "potato")], {
      constraints,
    });

    expect(req.constraints).toBe(constraints);
  });

  it("calls backend.optimize with the assembled request", async () => {
    const { backend, optimize } = makeBackend(async () => ALLOCATION);
    const client = new OptimizerClient(backend);

    const result = await client.optimize(ITEMS, [quote("hyperpure", "hp", "potato")]);

    expect(result).toBe(ALLOCATION);
    expect(optimize).toHaveBeenCalledTimes(1);
    const sent = optimize.mock.calls[0][0] as OptimizeRequest;
    expect(sent.items).toEqual(ITEMS);
  });

  it("explain() narrates per-item reasons, grand total and saving in rupees", () => {
    const { backend } = makeBackend(async () => ALLOCATION);
    const text = new OptimizerClient(backend).explain(ALLOCATION);

    expect(text).toContain("potato");
    expect(text).toContain("cheaper on Hyperpure");
    expect(text).toContain("Grand total ₹65");
    expect(text).toContain("You save ₹23");
  });

  it("explainAllocation reports a surcharge when the split costs more", () => {
    const costlier: Allocation = { ...ALLOCATION, savingPaise: 1500 };
    expect(explainAllocation(costlier)).toContain("costs ₹15 more");
  });

  it("explainAllocation lists unfulfilled items", () => {
    const withGap: Allocation = {
      ...ALLOCATION,
      unfulfilled: [{ canonicalItemId: "saffron", itemName: "saffron", reason: "out of stock" }],
    };
    expect(explainAllocation(withGap)).toContain("Could not source saffron");
  });
});

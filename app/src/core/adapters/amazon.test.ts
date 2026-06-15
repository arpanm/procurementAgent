import { beforeEach, describe, expect, it } from "vitest";
import type { BackendClient } from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import type { DomainEvent } from "../automation/events";
import { MockBridge } from "../automation/MockBridge";
import { createEngine, platformHealth, resetHealth } from "./SiteAdapterFactory";
import {
  AMZ_CHECKOUT_CREDIT,
  AMZ_LAYOUT_CHANGE,
  AMZ_OUT_OF_STOCK,
  AMZ_SEARCH_RESULTS,
  AMZ_SESSION_EXPIRED,
  mountFixture,
} from "./recordedFixtures";

function makeBackend(over: Partial<BackendClient> = {}): BackendClient {
  return {
    intent: async () => ({ items: [], confidence: 1 }),
    plan: async () => ({ normalizedItems: [], platforms: [] }),
    nextAction: async () => {
      throw new Error("nextAction was not stubbed for this test");
    },
    verify: async () => ({ ok: true, mismatches: [] }),
    optimize: async () => {
      throw new Error("optimize not implemented in test");
    },
    appendEvent: async () => {},
    createSession: async () => ({ id: "s1" }),
    getSession: async () => ({}),
    ...over,
  };
}

const onion: RequestedItem = { raw: "10kg onion", name: "onion", qty: 10, unit: "kg" };
const paneer: RequestedItem = { raw: "1kg paneer", name: "paneer", qty: 1, unit: "kg" };
const oil: RequestedItem = { raw: "1 carton refined oil", name: "refined oil", qty: 1, unit: "carton" };

beforeEach(() => {
  document.body.innerHTML = "";
  resetHealth();
});

describe("Amazon adapter", () => {
  it("search → readProduct returns parsed quotes for known SKUs", async () => {
    mountFixture(AMZ_SEARCH_RESULTS);
    const engine = createEngine("amazon", new MockBridge({ doc: document }), makeBackend());

    await engine.search(onion);
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("onion");

    const onionQuote = await engine.readProduct(onion);
    expect(onionQuote.skuId).toBe("B0ONION10");
    expect(onionQuote.platform).toBe("amazon");
    expect(onionQuote.title).toBe("Fresh Onion 10 kg");
    expect(onionQuote.pricePaise).toBe(26000);
    expect(onionQuote.inStock).toBe(true);
    expect(onionQuote.deliveryDate).toBe("Tomorrow");
    // The detail-page URL is captured (absolutised) so checkout can re-open the exact product.
    expect(onionQuote.productUrl?.endsWith("/dp/B0ONION10")).toBe(true);

    const paneerQuote = await engine.readProduct(paneer);
    expect(paneerQuote.skuId).toBe("B0PANEER1");
    expect(paneerQuote.pricePaise).toBe(39900);
    expect(paneerQuote.deliveryDate).toBe("12 Jun");

    const oilQuote = await engine.readProduct(oil);
    expect(oilQuote.skuId).toBe("B0OIL5L");
    expect(oilQuote.pricePaise).toBe(119900);
  });

  it("addToCart is reflected in the cart count", async () => {
    mountFixture(AMZ_SEARCH_RESULTS);
    const events: DomainEvent[] = [];
    const engine = createEngine("amazon", new MockBridge({ doc: document }), makeBackend());
    engine.on((e) => events.push(e));

    await engine.addToCart("B0ONION10", 1);

    expect(document.querySelector("[data-cart-badge]")!.textContent).toContain("Cart (1)");
    const added = events.find((e) => e.type === "ItemAddedToCart");
    expect(added && added.type === "ItemAddedToCart" ? added.cartCount : 0).toBe(1);
  });

  it("layout change → backend fallback recovers the search", async () => {
    mountFixture(AMZ_LAYOUT_CHANGE);
    let backendCalls = 0;
    const backend = makeBackend({
      nextAction: async ({ observation }) => {
        backendCalls += 1;
        const input = observation.elements.find((e) => e.tag === "input");
        if (input && !input.value) return { type: "type", idx: input.idx, value: onion.name };
        return { type: "done" };
      },
    });
    const engine = createEngine("amazon", new MockBridge({ doc: document }), backend);

    await engine.search(onion);

    expect(backendCalls).toBeGreaterThan(0);
    expect(document.querySelector<HTMLInputElement>('input[name="field-keywords"]')!.value).toBe(
      "onion",
    );
  });

  it("session expired → surfaces a re-login need without crashing", async () => {
    mountFixture(AMZ_SESSION_EXPIRED);
    const events: DomainEvent[] = [];
    const bridge = new MockBridge({ doc: document });
    const engine = createEngine("amazon", bridge, makeBackend());
    engine.on((e) => events.push(e));

    await expect(engine.search(onion)).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "NeedsOtp")).toBe(true);
    expect(bridge.shownIds).toContain("amazon");
  });

  it("out of stock → quote.inStock is false", async () => {
    mountFixture(AMZ_OUT_OF_STOCK);
    const engine = createEngine("amazon", new MockBridge({ doc: document }), makeBackend());

    const quote = await engine.readProduct(paneer);
    expect(quote.skuId).toBe("B0PANEER1");
    expect(quote.inStock).toBe(false);
    // Price/title/pack are still extracted on an out-of-stock tile — only `inStock` flips.
    expect(quote.title).toBe("Amul Malai Paneer 1 kg");
    expect(quote.pricePaise).toBe(39900);
    expect(quote.packSize).toBe("1 kg");
    expect(platformHealth("amazon").healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PHASE 0b REGRESSION LOCK — pin the EXACT current Amazon extraction output for
// every recorded fixture SKU. The per-platform-agent refactor MUST keep these
// values byte-for-byte identical; any drift here is a behaviour change to review.
// Values were captured from the current production extraction pipeline
// (selectors → buildQuoteDraft → WebViewAutomationEngine.buildQuote).
// ---------------------------------------------------------------------------
describe("Amazon adapter — recorded-fixture Quote contract (pre-refactor lock)", () => {
  /** The full Quote contract the current Amazon pipeline produces for each search-result SKU. */
  const EXPECTED = [
    {
      item: onion,
      skuId: "B0ONION10", // ASIN lifted from /dp/B0ONION10
      canonicalItemId: "onion",
      title: "Fresh Onion 10 kg",
      pricePaise: 26000,
      mrpPaise: undefined,
      packSize: "10 kg", // parsed out of the title
      inStock: true,
      productUrl: "http://localhost:3000/dp/B0ONION10",
      deliveryDate: "Tomorrow",
    },
    {
      item: paneer,
      skuId: "B0PANEER1",
      canonicalItemId: "paneer",
      title: "Amul Malai Paneer 1 kg",
      pricePaise: 39900,
      mrpPaise: undefined,
      packSize: "1 kg",
      inStock: true,
      productUrl: "http://localhost:3000/dp/B0PANEER1",
      deliveryDate: "12 Jun",
    },
    {
      item: oil,
      skuId: "B0OIL5L",
      canonicalItemId: "refined oil",
      title: "Fortune Refined Sunflower Oil 5 L",
      pricePaise: 119900,
      mrpPaise: undefined,
      packSize: "5 L",
      inStock: true,
      productUrl: "http://localhost:3000/dp/B0OIL5L",
      deliveryDate: "12 Jun",
    },
  ] as const;

  it.each(EXPECTED)(
    "locks the full Quote for $skuId",
    async ({ item, ...want }) => {
      mountFixture(AMZ_SEARCH_RESULTS);
      const engine = createEngine("amazon", new MockBridge({ doc: document }), makeBackend());

      const quote = await engine.readProduct(item);

      expect(quote.platform).toBe("amazon");
      expect(quote.skuId).toBe(want.skuId);
      expect(quote.canonicalItemId).toBe(want.canonicalItemId);
      expect(quote.title).toBe(want.title);
      expect(quote.pricePaise).toBe(want.pricePaise);
      expect(quote.mrpPaise).toBe(want.mrpPaise);
      expect(quote.packSize).toBe(want.packSize);
      expect(quote.inStock).toBe(want.inStock);
      expect(quote.productUrl).toBe(want.productUrl);
      expect(quote.deliveryDate).toBe(want.deliveryDate);
      // No MRP/MOV/stock-cap/delivery-fee is shown on these tiles, so they stay undefined.
      expect(quote.movPaise).toBeUndefined();
      expect(quote.stockCap).toBeUndefined();
      expect(quote.deliveryFeePaise).toBeUndefined();
      expect(typeof quote.readAt).toBe("string");
    },
  );

  // The out-of-stock tile is a SEPARATE recorded fixture and a distinct extraction path (only `inStock`
  // flips; title/price/pack/url/delivery are still read). Lock its FULL Quote so the refactor can't
  // regress out-of-stock extraction either.
  it("locks the full Quote for the out-of-stock paneer tile", async () => {
    mountFixture(AMZ_OUT_OF_STOCK);
    const engine = createEngine("amazon", new MockBridge({ doc: document }), makeBackend());

    const quote = await engine.readProduct(paneer);

    expect(quote.platform).toBe("amazon");
    expect(quote.skuId).toBe("B0PANEER1");
    expect(quote.canonicalItemId).toBe("paneer");
    expect(quote.title).toBe("Amul Malai Paneer 1 kg");
    expect(quote.pricePaise).toBe(39900);
    expect(quote.mrpPaise).toBeUndefined();
    expect(quote.packSize).toBe("1 kg");
    expect(quote.inStock).toBe(false); // "Currently unavailable" → out of stock
    expect(quote.productUrl).toBe("http://localhost:3000/dp/B0PANEER1");
    expect(quote.deliveryDate).toBe("12 Jun");
    expect(quote.movPaise).toBeUndefined();
    expect(quote.stockCap).toBeUndefined();
    expect(quote.deliveryFeePaise).toBeUndefined();
    expect(typeof quote.readAt).toBe("string");
  });

  // Amazon's checkout-detection path was previously only exercised for Hyperpure. Lock the Amazon
  // "payable on credit" read too, so the per-platform-agent refactor can't regress Amazon's
  // credit/total extraction (mirrors the Hyperpure "checkout detects credit, OTP and payment" test).
  it("detects an Amazon order payable on credit and reads the order total", async () => {
    mountFixture(AMZ_CHECKOUT_CREDIT);
    const engine = createEngine("amazon", new MockBridge({ doc: document }), makeBackend());

    const outcome = await engine.checkout();

    expect(outcome.kind).toBe("credit_ok");
    // "Place order on credit (Order total ₹1,459.00)" → credit_ok @ 145900 paise.
    if (outcome.kind === "credit_ok") expect(outcome.amountPaise).toBe(145900);
  });
});

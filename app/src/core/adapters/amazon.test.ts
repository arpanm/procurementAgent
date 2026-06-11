import { beforeEach, describe, expect, it } from "vitest";
import type { BackendClient } from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import type { DomainEvent } from "../automation/events";
import { MockBridge } from "../automation/MockBridge";
import { createEngine, platformHealth, resetHealth } from "./SiteAdapterFactory";
import {
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
    expect(platformHealth("amazon").healthy).toBe(true);
  });
});

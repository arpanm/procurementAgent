import { beforeEach, describe, expect, it } from "vitest";
import type { BackendClient } from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import type { DomainEvent } from "../automation/events";
import { MockBridge } from "../automation/MockBridge";
import { serializeDom } from "../automation/injected/domSerializer";
import { createEngine, markHealthy, markStale, platformHealth, resetHealth } from "./SiteAdapterFactory";
import {
  HP_CHECKOUT_CREDIT,
  HP_CHECKOUT_OTP,
  HP_CHECKOUT_PAYMENT,
  HP_LAYOUT_CHANGE,
  HP_OUT_OF_STOCK,
  HP_SEARCH_RESULTS,
  HP_SESSION_EXPIRED,
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

describe("Hyperpure adapter", () => {
  it("search → readProduct returns parsed quotes for known SKUs", async () => {
    mountFixture(HP_SEARCH_RESULTS);
    const engine = createEngine("hyperpure", new MockBridge({ doc: document }), makeBackend());

    await engine.search(onion);
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe("onion");

    const onionQuote = await engine.readProduct(onion);
    expect(onionQuote.skuId).toBe("HP-ONION-10KG");
    expect(onionQuote.platform).toBe("hyperpure");
    expect(onionQuote.title).toBe("Fresh Red Onion 10kg");
    expect(onionQuote.pricePaise).toBe(25000);
    expect(onionQuote.inStock).toBe(true);
    expect(onionQuote.deliveryDate).toBe("Tomorrow");

    const paneerQuote = await engine.readProduct(paneer);
    expect(paneerQuote.skuId).toBe("HP-PANEER-1KG");
    expect(paneerQuote.pricePaise).toBe(38500);

    const oilQuote = await engine.readProduct(oil);
    expect(oilQuote.skuId).toBe("HP-OIL-5L");
    expect(oilQuote.pricePaise).toBe(115000);
  });

  it("addToCart is reflected in the cart count via verify", async () => {
    mountFixture(HP_SEARCH_RESULTS);
    const events: DomainEvent[] = [];
    const engine = createEngine("hyperpure", new MockBridge({ doc: document }), makeBackend());
    engine.on((e) => events.push(e));

    await engine.addToCart("HP-ONION-10KG", 1);

    expect(document.querySelector("[data-cart-badge]")!.textContent).toContain("Cart (1)");
    const added = events.find((e) => e.type === "ItemAddedToCart");
    expect(added).toBeDefined();
    if (added && added.type === "ItemAddedToCart") {
      expect(added.skuId).toBe("HP-ONION-10KG");
      expect(added.cartCount).toBe(1);
    }
  });

  it("layout change → playbook step returns null, backend fallback recovers", async () => {
    mountFixture(HP_LAYOUT_CHANGE);
    let backendCalls = 0;
    const backend = makeBackend({
      nextAction: async ({ observation }) => {
        backendCalls += 1;
        const input = observation.elements.find((e) => e.tag === "input");
        if (input && !input.value) return { type: "type", idx: input.idx, value: onion.name };
        return { type: "done" };
      },
    });
    const engine = createEngine("hyperpure", new MockBridge({ doc: document }), backend);

    await engine.search(onion);

    expect(backendCalls).toBeGreaterThan(0);
    expect(document.querySelector<HTMLInputElement>('input[name="q"]')!.value).toBe("onion");
    expect(platformHealth("hyperpure").healthy).toBe(true);
  });

  it("session expired → surfaces a re-login need without crashing", async () => {
    mountFixture(HP_SESSION_EXPIRED);
    const events: DomainEvent[] = [];
    const bridge = new MockBridge({ doc: document });
    const engine = createEngine("hyperpure", bridge, makeBackend());
    engine.on((e) => events.push(e));

    await expect(engine.search(onion)).resolves.toBeUndefined();

    const otp = events.find((e) => e.type === "NeedsOtp");
    expect(otp).toBeDefined();
    if (otp && otp.type === "NeedsOtp") {
      expect(otp.prompt).toMatch(/session has expired/i);
    }
    expect(bridge.shownIds).toContain("hyperpure");
  });

  it("out of stock → quote.inStock is false", async () => {
    mountFixture(HP_OUT_OF_STOCK);
    const engine = createEngine("hyperpure", new MockBridge({ doc: document }), makeBackend());

    const quote = await engine.readProduct(paneer);
    expect(quote.skuId).toBe("HP-PANEER-1KG");
    expect(quote.inStock).toBe(false);
    expect(quote.pricePaise).toBe(38500);
  });

  it("checkout detects credit, OTP and payment", async () => {
    const creditEngine = createEngine(
      "hyperpure",
      new MockBridge({ doc: document }),
      makeBackend(),
    );
    mountFixture(HP_CHECKOUT_CREDIT);
    const credit = await creditEngine.checkout();
    expect(credit.kind).toBe("credit_ok");
    if (credit.kind === "credit_ok") expect(credit.amountPaise).toBe(63500);

    mountFixture(HP_CHECKOUT_OTP);
    const otp = await createEngine(
      "hyperpure",
      new MockBridge({ doc: document }),
      makeBackend(),
    ).checkout();
    expect(otp.kind).toBe("needs_otp");

    mountFixture(HP_CHECKOUT_PAYMENT);
    const pay = await createEngine(
      "hyperpure",
      new MockBridge({ doc: document }),
      makeBackend(),
    ).checkout();
    expect(pay.kind).toBe("needs_payment");
  });
});

describe("health store", () => {
  it("defaults healthy, markStale/markHealthy flip the indicator", () => {
    expect(platformHealth("hyperpure").healthy).toBe(true);
    expect(platformHealth("hyperpure").playbookVersion).toBe("hyperpure@1");

    markStale("hyperpure", "selector miss");
    expect(platformHealth("hyperpure").healthy).toBe(false);
    expect(platformHealth("hyperpure").lastError).toBe("selector miss");

    markHealthy("hyperpure");
    expect(platformHealth("hyperpure").healthy).toBe(true);
  });

  it("a StepFailed (circuit breaker) marks the platform stale", async () => {
    document.body.innerHTML = `<button>Hello</button>`;
    const backend = makeBackend({ nextAction: async () => ({ type: "click", idx: 999 }) });
    const engine = createEngine("hyperpure", new MockBridge({ doc: document }), backend, {
      maxActionRetries: 0,
      maxConsecutiveFailures: 3,
    });

    await expect(engine.addToCart("HP-ONION-10KG", 1)).rejects.toThrow();
    expect(platformHealth("hyperpure").healthy).toBe(false);
  });

  // helper to satisfy the "serializeDom is reachable for fixtures" sanity check
  it("serializes a fixture into an observation", () => {
    mountFixture(HP_SEARCH_RESULTS);
    const obs = serializeDom(document, window);
    expect(obs.elements.some((e) => /onion/i.test(e.name))).toBe(true);
  });
});

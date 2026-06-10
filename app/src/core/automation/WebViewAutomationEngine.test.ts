import { afterEach, describe, expect, it } from "vitest";
import type { BackendClient } from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import type { Observation, SerializedElement } from "./AutomationEngine";
import type { DomainEvent } from "./events";
import { MockBridge } from "./MockBridge";
import {
  CircuitBreakerError,
  WebViewAutomationEngine,
  type Playbooks,
} from "./WebViewAutomationEngine";

function makeBackend(over: Partial<BackendClient> = {}): BackendClient {
  const backend: BackendClient = {
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
  return backend;
}

const onion: RequestedItem = { raw: "10kg onion", name: "onion", qty: 10, unit: "kg" };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WebViewAutomationEngine with MockBridge", () => {
  it("runs a scripted search → read → addToCart playbook and emits the expected events", async () => {
    document.body.innerHTML = `
      <input role="searchbox" aria-label="Search products" />
      <button id="add">Add to cart</button>
      <a id="cart" href="/cart">Cart (0)</a>
    `;
    const cart = document.getElementById("cart")!;
    let count = 0;
    document.getElementById("add")!.addEventListener("click", () => {
      count++;
      cart.textContent = `Cart (${count})`;
    });

    const playbooks: Playbooks = {
      search: {
        name: "search",
        steps: [
          (ctx) => {
            const box = ctx.observation.elements.find(
              (e) => e.role === "searchbox" || e.tag === "input",
            );
            return box ? { type: "type", idx: box.idx, value: ctx.item?.name ?? "" } : null;
          },
        ],
      },
      readProduct: {
        name: "read",
        steps: [
          () => ({
            type: "extract",
            data: {
              skuId: "HP-ONION-10",
              title: "Fresh Onion 10kg",
              pricePaise: 25000,
              inStock: true,
            },
          }),
        ],
      },
      addToCart: {
        name: "add",
        steps: [
          (ctx) => {
            const btn = ctx.observation.elements.find((e) => /add to cart/i.test(e.name));
            return btn ? { type: "click", idx: btn.idx } : null;
          },
        ],
      },
    };

    const bridge = new MockBridge({ doc: document });
    const engine = new WebViewAutomationEngine({
      platform: "hyperpure",
      bridge,
      backend: makeBackend(),
      playbooks,
    });
    const events: DomainEvent[] = [];
    engine.on((e) => events.push(e));

    await engine.search(onion);
    const input = document.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("onion");

    const quote = await engine.readProduct(onion);
    expect(quote.skuId).toBe("HP-ONION-10");
    expect(quote.platform).toBe("hyperpure");
    expect(quote.pricePaise).toBe(25000);

    await engine.addToCart("HP-ONION-10", 1);

    const quoteRead = events.find((e) => e.type === "QuoteRead");
    expect(quoteRead).toBeDefined();

    const added = events.find((e) => e.type === "ItemAddedToCart");
    expect(added).toBeDefined();
    if (added && added.type === "ItemAddedToCart") {
      expect(added.skuId).toBe("HP-ONION-10");
      expect(added.qty).toBe(1);
      expect(added.cartCount).toBe(1);
    }
  });

  it("verifyStepEffect catches a no-op and accepts a real change", () => {
    const engine = new WebViewAutomationEngine({
      platform: "amazon",
      bridge: new MockBridge({ doc: document }),
      backend: makeBackend(),
    });

    const empty: Observation = {
      url: "http://shop/",
      title: "Shop",
      scroll: { y: 0, h: 0, vh: 0 },
      elements: [],
    };
    expect(engine.verifyStepEffect(empty, empty, { type: "click", idx: 0 })).toBe(false);

    const before: Observation = { ...empty, elements: [cartEl("Cart (0)")] };
    const after: Observation = { ...empty, elements: [cartEl("Cart (1)")] };
    expect(engine.verifyStepEffect(before, after, { type: "click", idx: 0 })).toBe(true);
  });

  it("trips the circuit breaker after 3 consecutive failures and emits StepFailed", async () => {
    document.body.innerHTML = `<button id="x">Hello</button>`;

    const bridge = new MockBridge({ doc: document });
    const engine = new WebViewAutomationEngine({
      platform: "amazon",
      bridge,
      // No playbook → every step defers to the backend, which keeps returning a stale click.
      backend: makeBackend({ nextAction: async () => ({ type: "click", idx: 999 }) }),
      maxActionRetries: 0,
      maxConsecutiveFailures: 3,
    });
    const events: DomainEvent[] = [];
    engine.on((e) => events.push(e));

    await expect(engine.addToCart("x", 1)).rejects.toBeInstanceOf(CircuitBreakerError);

    const failed = events.filter((e) => e.type === "StepFailed");
    expect(failed.length).toBe(1);
    if (failed[0] && failed[0].type === "StepFailed") {
      expect(failed[0].step).toBe("addToCart");
      expect(failed[0].platform).toBe("amazon");
      expect(failed[0].screenshotRef).toBeTruthy();
    }
    expect(bridge.screenshotCount).toBe(1);
  });

  it("detects an OTP field, emits NeedsOtp and reveals the webview", async () => {
    document.body.innerHTML = `<input aria-label="Enter OTP" autocomplete="one-time-code" />`;

    const bridge = new MockBridge({ doc: document });
    const engine = new WebViewAutomationEngine({
      platform: "hyperpure",
      bridge,
      backend: makeBackend(),
    });
    const events: DomainEvent[] = [];
    engine.on((e) => events.push(e));

    const outcome = await engine.checkout();
    expect(outcome.kind).toBe("needs_otp");

    const otp = events.find((e) => e.type === "NeedsOtp");
    expect(otp).toBeDefined();
    expect(bridge.shownIds).toContain("hyperpure");
  });
});

function cartEl(name: string): SerializedElement {
  return {
    idx: 0,
    tag: "a",
    role: null,
    name,
    value: null,
    bbox: [0, 0, 0, 0],
    attrs: { type: null, name: null, href: "/cart" },
  };
}

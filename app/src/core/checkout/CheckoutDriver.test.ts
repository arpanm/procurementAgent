import { describe, expect, it, vi } from "vitest";
import type {
  AutomationEngine,
  CartSnapshot,
  CheckoutOutcome,
  PlaceOrderResult,
} from "../automation/AutomationEngine";
import type { DomainEvent } from "../automation/events";
import type { BackendClient, VerifyRequest } from "../backend/BackendClient";
import type { AllocationLine, PlatformAllocation } from "../domain/types";
import { InMemorySecureStore } from "../secure/SecureStore";
import { AuditLog } from "../audit/AuditLog";
import { CheckoutDriver } from "./CheckoutDriver";
import { IdempotencyStore } from "./idempotency";

// ----- fixtures -----

const PLAN_LINE: AllocationLine = {
  canonicalItemId: "potato",
  itemName: "potato",
  platform: "hyperpure",
  skuId: "hp-potato",
  qty: 5,
  unitPricePaise: 1000,
  lineTotalPaise: 5000,
  reason: "cheaper on Hyperpure",
};

const ALLOCATION: PlatformAllocation = {
  platform: "hyperpure",
  lines: [PLAN_LINE],
  subtotalPaise: 5000,
  deliveryFeePaise: 0,
  totalPaise: 5000,
  meetsMov: true,
  payableOnCredit: true,
};

const MATCHING_CART: CartSnapshot = {
  platform: "hyperpure",
  lines: [{ skuId: "hp-potato", title: "Potato 1kg", qty: 5, unitPricePaise: 1000 }],
  subtotalPaise: 5000,
};

const PLACE_RESULT: PlaceOrderResult = {
  orderRef: "HP-ORDER-9988",
  totalPaise: 5000,
  paidOnCredit: true,
};

interface FakeEngine {
  readonly engine: AutomationEngine;
  readonly calls: string[];
  readonly checkout: ReturnType<typeof vi.fn>;
  readonly placeOrder: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
  readonly getCart: ReturnType<typeof vi.fn>;
}

function makeFakeEngine(opts: {
  cart?: CartSnapshot;
  outcomes?: CheckoutOutcome[];
  placeResult?: PlaceOrderResult;
}): FakeEngine {
  const cart = opts.cart ?? MATCHING_CART;
  const outcomes = opts.outcomes ?? [{ kind: "credit_ok", amountPaise: 5000 }];
  const placeResult = opts.placeResult ?? PLACE_RESULT;
  const calls: string[] = [];
  let idx = 0;

  const getCart = vi.fn(async () => {
    calls.push("getCart");
    return cart;
  });
  const checkout = vi.fn(async () => {
    calls.push("checkout");
    const out = outcomes[Math.min(idx, outcomes.length - 1)];
    idx += 1;
    return out;
  });
  const placeOrder = vi.fn(async (key: string) => {
    calls.push(`placeOrder:${key}`);
    return placeResult;
  });
  const show = vi.fn(async () => {
    calls.push("show");
  });

  const engine: AutomationEngine = {
    platform: cart.platform,
    open: async (...args) => {
      calls.push("open");
      void args;
    },
    close: async () => {
      calls.push("close");
    },
    show,
    hide: async () => {
      calls.push("hide");
    },
    search: async (...args) => {
      calls.push("search");
      void args;
    },
    readProduct: async (...args) => {
      calls.push("readProduct");
      void args;
      throw new Error("not used in checkout tests");
    },
    addToCart: async (...args) => {
      calls.push("addToCart");
      void args;
    },
    getCart,
    checkout,
    placeOrder,
    on: () => () => {},
  };

  return { engine, calls, checkout, placeOrder, show, getCart };
}

function makeBackend(verify?: (req: VerifyRequest) => Promise<{ ok: boolean; mismatches: string[] }>): BackendClient {
  const reject = () => Promise.reject(new Error("not used"));
  return {
    intent: reject as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: (verify ??
      (async () => ({ ok: true, mismatches: [] }))) as unknown as BackendClient["verify"],
    optimize: reject as unknown as BackendClient["optimize"],
    appendEvent: (async () => undefined) as unknown as BackendClient["appendEvent"],
    createSession: (async () => ({ id: "s1" })) as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
  };
}

function makeDriver(
  fake: FakeEngine,
  extra: {
    awaitHuman?: () => Promise<void>;
    onEvent?: (e: DomainEvent) => void;
    idempotency?: IdempotencyStore;
    backendVerify?: (req: VerifyRequest) => Promise<{ ok: boolean; mismatches: string[] }>;
  } = {},
): { driver: CheckoutDriver; audit: AuditLog; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  const audit = new AuditLog(new InMemorySecureStore(), "audit:test");
  let tick = 0;
  const driver = new CheckoutDriver({
    engine: fake.engine,
    backend: makeBackend(extra.backendVerify),
    audit,
    onEvent: (e) => {
      events.push(e);
      extra.onEvent?.(e);
    },
    awaitHuman: extra.awaitHuman ?? (() => Promise.resolve()),
    idempotency: extra.idempotency,
    now: () => `2026-01-01T00:00:0${(tick++ % 10).toString()}.000Z`,
  });
  return { driver, audit, events };
}

// ----- Verifier safety gate: blocks 100% of cart mismatches -----

describe("CheckoutDriver — Verifier safety gate", () => {
  const mismatchCases: { name: string; cart: CartSnapshot }[] = [
    {
      name: "wrong qty",
      cart: {
        platform: "hyperpure",
        lines: [{ skuId: "hp-potato", title: "Potato", qty: 4, unitPricePaise: 1000 }],
        subtotalPaise: 4000,
      },
    },
    {
      name: "wrong price beyond tolerance",
      cart: {
        platform: "hyperpure",
        lines: [{ skuId: "hp-potato", title: "Potato", qty: 5, unitPricePaise: 1500 }],
        subtotalPaise: 7500,
      },
    },
    {
      name: "missing sku",
      cart: { platform: "hyperpure", lines: [], subtotalPaise: 0 },
    },
    {
      name: "extra sku",
      cart: {
        platform: "hyperpure",
        lines: [
          { skuId: "hp-potato", title: "Potato", qty: 5, unitPricePaise: 1000 },
          { skuId: "hp-onion", title: "Onion", qty: 2, unitPricePaise: 800 },
        ],
        subtotalPaise: 6600,
      },
    },
  ];

  it.each(mismatchCases)(
    "blocks checkout on %s and never calls checkout/placeOrder",
    async ({ cart }) => {
      const fake = makeFakeEngine({ cart });
      const { driver, events } = makeDriver(fake);

      const attempt = await driver.run(ALLOCATION);

      expect(attempt.status).toBe("failed");
      expect(attempt.orderRef).toBeUndefined();
      expect(fake.checkout).not.toHaveBeenCalled();
      expect(fake.placeOrder).not.toHaveBeenCalled();
      expect(fake.show).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === "StepFailed")).toBe(true);
      expect(events.some((e) => e.type === "OrderPlaced")).toBe(false);
    },
  );

  it("blocks even when the backend verifier wrongly approves a tampered cart (defense-in-depth)", async () => {
    const fake = makeFakeEngine({
      cart: {
        platform: "hyperpure",
        lines: [{ skuId: "hp-potato", title: "Potato", qty: 999, unitPricePaise: 1000 }],
        subtotalPaise: 999000,
      },
    });
    // Backend says everything is fine — the local check must still block.
    const { driver } = makeDriver(fake, {
      backendVerify: async () => ({ ok: true, mismatches: [] }),
    });

    const attempt = await driver.run(ALLOCATION);

    expect(attempt.status).toBe("failed");
    expect(fake.checkout).not.toHaveBeenCalled();
    expect(fake.placeOrder).not.toHaveBeenCalled();
  });
});

// ----- HITL: pauses for human at OTP and payment -----

describe("CheckoutDriver — OTP/payment hand-off", () => {
  it("pauses for the human at every OTP and payment gate, then resumes", async () => {
    const fake = makeFakeEngine({
      outcomes: [
        { kind: "needs_otp", prompt: "Enter the OTP Hyperpure just sent you" },
        { kind: "needs_payment", amountPaise: 5000, prompt: "Complete payment to place this order" },
        { kind: "credit_ok", amountPaise: 5000 },
      ],
    });

    // First human gate is held open so we can prove the flow WAITS before continuing.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let humanCalls = 0;
    const awaitHuman = vi.fn(() => {
      humanCalls += 1;
      return humanCalls === 1 ? firstGate : Promise.resolve();
    });

    const { driver, events } = makeDriver(fake, { awaitHuman });

    const runPromise = driver.run(ALLOCATION);
    // Flush the microtask queue; the driver should then be parked on the (still-open) first gate.
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }

    expect(fake.show).toHaveBeenCalledTimes(1);
    expect(awaitHuman).toHaveBeenCalledTimes(1);
    expect(fake.placeOrder).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "NeedsOtp")).toBe(true);

    // Resume the human and let the rest of the flow run.
    releaseFirst();
    const attempt = await runPromise;

    expect(attempt.status).toBe("placed");
    // One pause per OTP + one per payment.
    expect(awaitHuman).toHaveBeenCalledTimes(2);
    expect(fake.show).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "NeedsPayment")).toBe(true);
    expect(events.some((e) => e.type === "OrderPlaced")).toBe(true);
    expect(fake.placeOrder).toHaveBeenCalledTimes(1);
  });

  it("never exposes or uses any method that fills an OTP/payment field", async () => {
    const fake = makeFakeEngine({
      outcomes: [
        { kind: "needs_otp", prompt: "OTP" },
        { kind: "needs_payment", amountPaise: 5000, prompt: "Pay" },
        { kind: "credit_ok", amountPaise: 5000 },
      ],
    });
    const { driver } = makeDriver(fake);

    await driver.run(ALLOCATION);

    // The driver only ever drives high-level engine methods. The way it handles OTP/payment is by
    // revealing the live site and waiting for a human — not by typing.
    const allowed = new Set(["getCart", "checkout", "show", "placeOrder:hyperpure"]);
    for (const call of fake.calls) {
      const base = call.startsWith("placeOrder:") ? "placeOrder:hyperpure" : call;
      expect(allowed.has(base)).toBe(true);
    }

    // There is no OTP/payment-filling capability on the engine surface the driver speaks to.
    for (const forbidden of ["fillOtp", "enterOtp", "typeOtp", "submitPayment", "payWithCard"]) {
      expect(forbidden in fake.engine).toBe(false);
    }
  });
});

// ----- credit_ok happy path + idempotency -----

describe("CheckoutDriver — placement & idempotency", () => {
  it("places the order once on credit_ok and captures the order reference", async () => {
    const fake = makeFakeEngine({});
    const { driver, audit } = makeDriver(fake);

    const attempt = await driver.run(ALLOCATION);

    expect(fake.placeOrder).toHaveBeenCalledTimes(1);
    expect(attempt.status).toBe("placed");
    expect(attempt.orderRef).toBe("HP-ORDER-9988");
    expect(attempt.totalPaise).toBe(5000);
    expect(attempt.paidOnCredit).toBe(true);

    const trail = await audit.entries();
    const placed = trail.find((e) => e.action === "order:placed");
    expect(placed?.after).toMatchObject({ orderRef: "HP-ORDER-9988" });
  });

  it("a retry with the same idempotency key does not place twice (no duplicate OrderPlaced)", async () => {
    const fake = makeFakeEngine({});
    const sharedIdem = new IdempotencyStore(new InMemorySecureStore());
    const { driver, events } = makeDriver(fake, { idempotency: sharedIdem });

    const first = await driver.run(ALLOCATION);
    const second = await driver.run(ALLOCATION);

    expect(fake.placeOrder).toHaveBeenCalledTimes(1);
    expect(first.orderRef).toBe(second.orderRef);
    expect(second.status).toBe("placed");

    const placedEvents = events.filter((e) => e.type === "OrderPlaced");
    expect(placedEvents).toHaveLength(1);
  });
});

// ----- audit trail completeness -----

describe("CheckoutDriver — audit trail", () => {
  it("writes a complete, tamper-evident trail for a placed order", async () => {
    const fake = makeFakeEngine({});
    const { driver, audit } = makeDriver(fake);

    await driver.run(ALLOCATION);

    const actions = (await audit.entries()).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "checkout:start",
        "cart:read",
        "verify:ok",
        "order:placed",
      ]),
    );
    expect(await audit.verifyIntegrity()).toBe(true);
  });
});

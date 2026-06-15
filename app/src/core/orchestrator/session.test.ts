import { describe, expect, it } from "vitest";
import type {
  Allocation,
  ProcurementRequest,
  Quote,
  RequestedItem,
} from "../domain/types";
import {
  apply,
  hydrate,
  initialState,
  type SessionEvent,
} from "./session";

const ITEMS: readonly RequestedItem[] = [
  { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" },
  { raw: "2 carton oil", name: "refined oil", qty: 2, unit: "carton" },
];

const REQUEST: ProcurementRequest = {
  id: "req-1",
  items: ITEMS,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function quote(platform: Quote["platform"], skuId: string, canonicalItemId: string): Quote {
  return {
    platform,
    skuId,
    canonicalItemId,
    title: `${canonicalItemId} on ${platform}`,
    pricePaise: 1000,
    inStock: true,
    readAt: "2026-01-01T00:00:00.000Z",
  };
}

function allocation(): Allocation {
  return {
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
        deliveryFeePaise: 0,
        totalPaise: 5000,
        meetsMov: true,
        payableOnCredit: true,
      },
      {
        platform: "amazon",
        lines: [
          {
            canonicalItemId: "refined oil",
            itemName: "refined oil",
            platform: "amazon",
            skuId: "az-oil",
            qty: 2,
            unitPricePaise: 2000,
            lineTotalPaise: 4000,
            reason: "cheaper on Amazon",
          },
        ],
        subtotalPaise: 4000,
        deliveryFeePaise: 0,
        totalPaise: 4000,
        meetsMov: true,
        payableOnCredit: true,
      },
    ],
    grandTotalPaise: 9000,
    singlePlatformBaselinePaise: 11000,
    savingPaise: -2000,
    unfulfilled: [],
  };
}

/** A canonical happy-path event log up to (but not past) approval. */
function logToApproval(): SessionEvent[] {
  return [
    { type: "SessionStarted", request: REQUEST },
    { type: "PlanReady", items: ITEMS },
    { type: "QuoteCollected", quote: quote("hyperpure", "hp-potato", "potato") },
    { type: "QuoteCollected", quote: quote("amazon", "az-oil", "refined oil") },
    { type: "OptimizeStarted" },
    { type: "Optimized", allocation: allocation() },
    { type: "ApprovalRequested" },
  ];
}

describe("session reducer", () => {
  it("starts idle", () => {
    expect(initialState("s1").status).toBe("idle");
  });

  it("SessionStarted → planning and records the request", () => {
    const s = apply(initialState("s1"), { type: "SessionStarted", request: REQUEST });
    expect(s.status).toBe("planning");
    expect(s.request).toEqual(REQUEST);
    expect(s.items).toEqual(ITEMS);
    expect(s.version).toBe(1);
  });

  it("PlanReady → quoting with normalized items", () => {
    let s = apply(initialState("s1"), { type: "SessionStarted", request: REQUEST });
    const normalized: RequestedItem[] = [{ raw: "potato", name: "potato", qty: 5, unit: "kg" }];
    s = apply(s, { type: "PlanReady", items: normalized });
    expect(s.status).toBe("quoting");
    expect(s.items).toEqual(normalized);
  });

  it("QuoteCollected upserts by platform+sku (no duplicates)", () => {
    let s = apply(initialState("s1"), { type: "SessionStarted", request: REQUEST });
    s = apply(s, { type: "PlanReady", items: ITEMS });
    s = apply(s, { type: "QuoteCollected", quote: quote("hyperpure", "hp-potato", "potato") });
    s = apply(s, { type: "QuoteCollected", quote: quote("hyperpure", "hp-potato", "potato") });
    expect(s.quotes).toHaveLength(1);
  });

  it("optimize flow reaches awaiting_approval and stores the allocation", () => {
    const s = hydrate("s1", logToApproval());
    expect(s.status).toBe("awaiting_approval");
    expect(s.allocation?.grandTotalPaise).toBe(9000);
    expect(s.approved).toBe(false);
  });

  it("Approved is the ONLY path to approved (gating)", () => {
    const s = hydrate("s1", logToApproval());
    const approved = apply(s, { type: "Approved" });
    expect(approved.status).toBe("approved");
    expect(approved.approved).toBe(true);
  });

  it("PinsSeeded sets default platform picks without changing status", () => {
    let s = apply(initialState("s1"), { type: "SessionStarted", request: REQUEST });
    s = apply(s, { type: "PlanReady", items: ITEMS });
    const before = s.status;
    s = apply(s, { type: "PinsSeeded", pins: { potato: "amazon", "refined oil": "hyperpure" } });
    expect(s.status).toBe(before); // seeding a default is not a state transition
    expect(s.pins).toEqual({ potato: "amazon", "refined oil": "hyperpure" });
  });

  it("PinsSeeded never overrides an explicit user swap-platform pin", () => {
    let s = hydrate("s1", logToApproval());
    // User explicitly pins potato to amazon...
    s = apply(s, {
      type: "ModifyRequested",
      change: { kind: "swap-platform", canonicalItemId: "potato", itemName: "potato", platform: "amazon" },
    });
    // ...then a (late) default seed tries to set potato → hyperpure. User pin must win.
    s = apply(s, { type: "PinsSeeded", pins: { potato: "hyperpure", "refined oil": "amazon" } });
    expect(s.pins.potato).toBe("amazon");
    expect(s.pins["refined oil"]).toBe("amazon");
  });

  it("CheckoutFinished moves an approved session to done (cart hand-off terminal)", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, { type: "Approved" });
    s = apply(s, { type: "CheckoutFinished" });
    expect(s.status).toBe("done");
  });

  it("CheckoutFinished is ignored before approval", () => {
    const s = hydrate("s1", logToApproval());
    const after = apply(s, { type: "CheckoutFinished" });
    expect(after).toBe(s); // unchanged reference: ignored pre-approval
  });

  it("ignores Approved unless awaiting_approval (no irreversible jump)", () => {
    let s = apply(initialState("s1"), { type: "SessionStarted", request: REQUEST });
    s = apply(s, { type: "PlanReady", items: ITEMS });
    const after = apply(s, { type: "Approved" });
    expect(after).toBe(s); // unchanged reference: event ignored
    expect(after.approved).toBe(false);
  });

  it("ModifyRequested change-qty reshapes demand and re-opens for re-optimize", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, { type: "ModifyRequested", change: { kind: "change-qty", itemName: "potato", qty: 9 } });
    expect(s.status).toBe("modifying");
    expect(s.items.find((i) => i.name === "potato")?.qty).toBe(9);
    expect(s.approved).toBe(false);
  });

  it("ModifyRequested swap-platform pins the item to a platform", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, {
      type: "ModifyRequested",
      change: { kind: "swap-platform", canonicalItemId: "potato", itemName: "potato", platform: "amazon" },
    });
    expect(s.pins.potato).toBe("amazon");
  });

  it("ModifyRequested drop-item removes the item from demand", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, { type: "ModifyRequested", change: { kind: "drop-item", itemName: "refined oil" } });
    expect(s.items.map((i) => i.name)).toEqual(["potato"]);
  });

  it("CandidatesCollected stores ranked alternatives per item (no-op on identical re-read)", () => {
    let s = apply(initialState("s1"), { type: "SessionStarted", request: REQUEST });
    s = apply(s, { type: "PlanReady", items: ITEMS });
    const candidates = [
      quote("hyperpure", "hp-potato-5kg", "potato"),
      quote("hyperpure", "hp-potato-10kg", "potato"),
    ];
    s = apply(s, { type: "CandidatesCollected", canonicalItemId: "potato", candidates });
    expect(s.candidatesByItem.potato).toEqual(candidates);
    const v = s.version;
    // Re-applying the identical list is a no-op (preserves reference / version).
    const again = apply(s, { type: "CandidatesCollected", canonicalItemId: "potato", candidates });
    expect(again).toBe(s);
    expect(again.version).toBe(v);
  });

  it("ModifyRequested select-sku swaps the chosen quote and pins the platform", () => {
    const alt = quote("hyperpure", "hp-potato-10kg", "potato");
    let s = hydrate("s1", [
      { type: "SessionStarted", request: REQUEST },
      { type: "PlanReady", items: ITEMS },
      { type: "QuoteCollected", quote: quote("hyperpure", "hp-potato", "potato") },
      {
        type: "CandidatesCollected",
        canonicalItemId: "potato",
        candidates: [quote("hyperpure", "hp-potato", "potato"), alt],
      },
      { type: "OptimizeStarted" },
      { type: "Optimized", allocation: allocation() },
      { type: "ApprovalRequested" },
    ]);
    s = apply(s, {
      type: "ModifyRequested",
      change: {
        kind: "select-sku",
        canonicalItemId: "potato",
        itemName: "potato",
        platform: "hyperpure",
        skuId: "hp-potato-10kg",
      },
    });
    // The hyperpure potato quote is replaced by the picked SKU, and the platform is pinned.
    const potatoQuotes = s.quotes.filter(
      (q) => q.canonicalItemId === "potato" && q.platform === "hyperpure",
    );
    expect(potatoQuotes).toHaveLength(1);
    expect(potatoQuotes[0].skuId).toBe("hp-potato-10kg");
    expect(s.pins.potato).toBe("hyperpure");
    expect(s.status).toBe("modifying");
  });

  it("ModifyRequested select-sku with an unknown SKU only pins (no quote change)", () => {
    let s = hydrate("s1", logToApproval());
    const before = s.quotes;
    s = apply(s, {
      type: "ModifyRequested",
      change: {
        kind: "select-sku",
        canonicalItemId: "potato",
        itemName: "potato",
        platform: "amazon",
        skuId: "does-not-exist",
      },
    });
    expect(s.quotes).toBe(before);
    expect(s.pins.potato).toBe("amazon");
  });

  it("Cancelled → cancelled and is terminal", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, { type: "Cancelled" });
    expect(s.status).toBe("cancelled");
    const again = apply(s, { type: "PlanReady", items: ITEMS });
    expect(again).toBe(s); // terminal: ignored
  });

  it("ignores automation events before approval (no OTP/payment pre-approval)", () => {
    const s = hydrate("s1", logToApproval());
    const after = apply(s, { type: "NeedsOtp", platform: "hyperpure", prompt: "enter otp" });
    expect(after).toBe(s);
    expect(after.status).toBe("awaiting_approval");
  });

  it("after approval, NeedsOtp/NeedsPayment surface and OrderPlaced for all platforms → done", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, { type: "Approved" });
    s = apply(s, { type: "NeedsOtp", platform: "hyperpure", prompt: "otp" });
    expect(s.status).toBe("needs_otp");
    s = apply(s, {
      type: "OrderPlaced",
      platform: "hyperpure",
      orderRef: "HP1",
      totalPaise: 5000,
      paidOnCredit: true,
    });
    expect(s.status).toBe("placing"); // amazon still pending
    s = apply(s, {
      type: "OrderPlaced",
      platform: "amazon",
      orderRef: "AZ1",
      totalPaise: 4000,
      paidOnCredit: false,
    });
    expect(s.status).toBe("done");
    expect(s.orderAttempts).toHaveLength(2);
  });

  it("StepFailed → failed with reason", () => {
    let s = hydrate("s1", logToApproval());
    s = apply(s, { type: "Approved" });
    s = apply(s, { type: "StepFailed", platform: "amazon", step: "checkout", reason: "boom" });
    expect(s.status).toBe("failed");
    expect(s.error).toBe("boom");
  });

  it("hydrate replays the log to the exact live state and counts versions", () => {
    const log = logToApproval();
    const s = hydrate("s1", log);
    expect(s.version).toBe(log.length);
    expect(s.status).toBe("awaiting_approval");
    // Replaying again from scratch is deterministic.
    expect(hydrate("s1", log)).toEqual(s);
  });
});

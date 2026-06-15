import { describe, expect, it, vi } from "vitest";
import type { RequestedItem } from "../../domain/types";
import type {
  ActionResult,
  EngineAction,
  Observation,
  SerializedElement,
} from "../../automation/AutomationEngine";
import type { BrowserSession } from "../PlatformAgent";
import { AmazonAgent } from "./AmazonAgent";
import { AMZ_DETAIL_PANEER } from "./detailFixtures";

const item: RequestedItem = {
  raw: "6 packets of milky mist 500 gm paneer",
  name: "paneer",
  qty: 6,
  unit: "packet",
  brand: "Milky Mist",
  packSize: "500 g",
};

function el(partial: Partial<SerializedElement> & { idx: number }): SerializedElement {
  return {
    idx: partial.idx,
    tag: partial.tag ?? "div",
    role: partial.role ?? null,
    name: partial.name ?? "",
    value: partial.value ?? null,
    bbox: partial.bbox ?? [0, 0, 10, 10],
    attrs: partial.attrs ?? {},
  };
}

/** A minimal search-results observation with one product card linking to the paneer detail page. */
const LISTING: Observation = {
  url: "https://www.amazon.in/s?k=Milky+Mist+paneer+500+g",
  title: "Amazon.in : Milky Mist paneer",
  scroll: { y: 0, h: 2000, vh: 800 },
  elements: [
    el({
      idx: 1,
      tag: "a",
      role: "link",
      name: "Milky Mist Paneer, 500 g ₹237.00",
      attrs: { href: "/Milky-Mist-Paneer-500g/dp/B018E0LQ8W/ref=sr_1_1" },
    }),
  ],
};

/**
 * A scripted BrowserSession: `observe()` returns the LISTING first, then whatever detail/after
 * observation we queue. `open()` advances to the next queued observation.
 */
function scriptedSession(detailObs: Observation, opts: { actOk?: boolean } = {}): BrowserSession {
  const queue: Observation[] = [LISTING, detailObs];
  let idx = 0;
  const observe = vi.fn(async () => queue[Math.min(idx, queue.length - 1)]);
  const open = vi.fn(async () => {
    idx = Math.min(idx + 1, queue.length - 1);
  });
  const act = vi.fn(async (_a: EngineAction): Promise<ActionResult> => ({ ok: opts.actOk ?? true }));
  return {
    platform: "amazon",
    open,
    close: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(undefined),
    readProduct: vi.fn().mockRejectedValue(new Error("legacy read should not be hit in this test")),
    addToCart: vi.fn().mockResolvedValue(undefined),
    getCart: vi.fn().mockResolvedValue({ platform: "amazon", lines: [], subtotalPaise: 0 }),
    checkout: vi.fn().mockResolvedValue({ kind: "credit_ok", amountPaise: 0 }),
    placeOrder: vi.fn().mockResolvedValue({ orderRef: "x", totalPaise: 0, paidOnCredit: true }),
    on: vi.fn().mockReturnValue(() => undefined),
    observe,
    act,
    captureScreenshot: vi.fn().mockResolvedValue(null),
  } as BrowserSession;
}

describe("AmazonAgent.readQuote", () => {
  it("reads the TRUE detail-page price (₹237), not the noisy listing", async () => {
    const session = scriptedSession(AMZ_DETAIL_PANEER);
    const agent = new AmazonAgent({
      session,
      cartUrl: "https://www.amazon.in/gp/cart/view.html",
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const { chosen: quote, candidates } = await agent.readQuote(item);

    expect(quote.platform).toBe("amazon");
    expect(quote.pricePaise).toBe(23700); // the buybox ₹237, NOT ₹99
    expect(quote.skuId).toBe("B018E0LQ8W"); // ASIN from the detail URL
    expect(quote.productUrl).toBe("https://www.amazon.in/dp/B018E0LQ8W");
    expect(quote.inStock).toBe(true);
    expect(quote.packSize).toBe("500 g");
    expect(quote.title.toLowerCase()).toContain("milky mist paneer");
    // Amazon reads one true buybox product → candidates is just the chosen quote.
    expect(candidates).toEqual([quote]);
    // It navigated into the detail page.
    expect(session.open).toHaveBeenCalledWith("https://www.amazon.in/dp/B018E0LQ8W", { hidden: false });
  });

  it("honors knowledge.policies.priceFromDetailPage=false by trusting the listing read", async () => {
    const session = scriptedSession(AMZ_DETAIL_PANEER);
    const listingQuote = {
      platform: "amazon" as const,
      skuId: "X",
      canonicalItemId: "paneer",
      title: "listing read",
      pricePaise: 9900,
      inStock: true,
      readAt: "2026-01-01T00:00:00.000Z",
    };
    session.readProduct = vi.fn().mockResolvedValue(listingQuote);
    const agent = new AmazonAgent({
      session,
      knowledge: {
        platform: "amazon",
        version: 1,
        policies: { priceFromDetailPage: false, trustListingPrice: true },
        hints: {
          rejectTokens: [],
          processedVariantTokens: [],
          atcTokens: [],
          addedTokens: [],
          searchNotes: [],
        },
        notes: [],
      },
    });

    const { chosen: quote } = await agent.readQuote(item);
    expect(quote).toEqual(listingQuote);
    // It trusted the listing read and never opened the detail page.
    expect(session.open).not.toHaveBeenCalled();
  });

  it("falls back to the legacy engine read when no detail price is found", async () => {
    const blankDetail: Observation = {
      url: "https://www.amazon.in/dp/B018E0LQ8W",
      title: "",
      scroll: { y: 0, h: 0, vh: 0 },
      elements: [],
    };
    const session = scriptedSession(blankDetail);
    const fallbackQuote = {
      platform: "amazon" as const,
      skuId: "B018E0LQ8W",
      canonicalItemId: "paneer",
      title: "Milky Mist Paneer",
      pricePaise: 0,
      inStock: false,
      readAt: "2026-01-01T00:00:00.000Z",
    };
    session.readProduct = vi.fn().mockResolvedValue(fallbackQuote);

    const agent = new AmazonAgent({ session });
    const { chosen: quote } = await agent.readQuote(item);
    expect(session.readProduct).toHaveBeenCalledWith(item);
    expect(quote).toEqual(fallbackQuote);
  });
});

describe("AmazonAgent.addToCart", () => {
  const detailWithAtc: Observation = {
    url: "https://www.amazon.in/dp/B018E0LQ8W",
    title: "Milky Mist Paneer, 500 g",
    scroll: { y: 0, h: 1200, vh: 800 },
    elements: [
      el({ idx: 5, tag: "button", role: "button", name: "Add to Cart", bbox: [20, 600, 200, 44] }),
    ],
  };

  it("returns 'added' when the native button is clicked and the add is confirmed", async () => {
    const confirmed: Observation = {
      ...detailWithAtc,
      elements: [
        ...detailWithAtc.elements,
        el({ idx: 9, name: "Added to Cart", bbox: [20, 100, 200, 30] }),
        el({ idx: 10, name: "Cart subtotal (1 item): ₹237.00", bbox: [20, 140, 300, 30] }),
      ],
    };
    // observe(): listing, then detail-with-atc (open), then confirmed (after click).
    const session = scriptedSession(detailWithAtc);
    const observe = vi
      .fn()
      .mockResolvedValueOnce(detailWithAtc) // after open(productUrl)
      .mockResolvedValueOnce(confirmed); // after click
    session.observe = observe;

    const agent = new AmazonAgent({ session, cartUrl: "https://www.amazon.in/gp/cart/view.html" });
    const result = await agent.addToCart({
      skuId: "B018E0LQ8W",
      qty: 6,
      productUrl: "https://www.amazon.in/dp/B018E0LQ8W",
    });

    expect(result.status).toBe("added");
    expect(result.cartUrl).toBe("https://www.amazon.in/gp/cart/view.html");
    expect(session.act).toHaveBeenCalledWith({ type: "click", idx: 5 });
  });

  it("returns 'failed' with the product link when the add can't be confirmed", async () => {
    const stillDetail: Observation = detailWithAtc; // no confirmation markers appear
    const session = scriptedSession(detailWithAtc);
    session.observe = vi.fn().mockResolvedValue(stillDetail);

    const agent = new AmazonAgent({ session });
    const result = await agent.addToCart({
      skuId: "B018E0LQ8W",
      qty: 6,
      productUrl: "https://www.amazon.in/dp/B018E0LQ8W",
    });

    expect(result.status).toBe("failed");
    expect(result.productUrl).toBe("https://www.amazon.in/dp/B018E0LQ8W");
    expect(result.reason).toContain("not confirmed");
  });

  it("returns 'failed' immediately when there is no product URL", async () => {
    const session = scriptedSession(detailWithAtc);
    const agent = new AmazonAgent({ session });
    const result = await agent.addToCart({ skuId: "B018E0LQ8W", qty: 1 });
    expect(result.status).toBe("failed");
    expect(session.open).not.toHaveBeenCalled();
  });
});

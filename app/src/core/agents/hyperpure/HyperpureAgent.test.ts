import { describe, expect, it, vi } from "vitest";
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import type { Quote, RequestedItem } from "../../domain/types";
import type { BrowserSession } from "../PlatformAgent";
import { SiteMemory } from "../../knowledge/siteMemory";
import { HyperpureAgent } from "./HyperpureAgent";

const item: RequestedItem = {
  raw: "5 milky mist paneer 1 kg",
  name: "paneer",
  qty: 1,
  unit: "kg",
  brand: "Milky Mist",
  packSize: "1 kg",
};

const quote: Quote = {
  platform: "hyperpure",
  skuId: "HP-PANEER-1KG",
  canonicalItemId: "paneer",
  title: "Milky Mist - Paneer, 1 Kg",
  pricePaise: 39900,
  inStock: true,
  readAt: "2026-01-01T00:00:00.000Z",
};

function el(p: Partial<SerializedElement> & { idx: number }): SerializedElement {
  return {
    idx: p.idx,
    tag: p.tag ?? "div",
    role: p.role ?? null,
    name: p.name ?? "",
    value: p.value ?? null,
    bbox: p.bbox ?? [0, 0, 0, 0],
    attrs: p.attrs ?? {},
  };
}

function obs(elements: SerializedElement[], url: string): Observation {
  return { url, title: "", scroll: { y: 0, h: 0, vh: 0 }, elements };
}

function fakeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    platform: "hyperpure",
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(undefined),
    readProduct: vi.fn().mockResolvedValue(quote),
    addToCart: vi.fn().mockResolvedValue(undefined),
    getCart: vi.fn().mockResolvedValue({ platform: "hyperpure", lines: [], subtotalPaise: 0 }),
    checkout: vi.fn().mockResolvedValue({ kind: "credit_ok", amountPaise: 0 }),
    placeOrder: vi.fn().mockResolvedValue({ orderRef: "x", totalPaise: 0, paidOnCredit: true }),
    on: vi.fn().mockReturnValue(() => undefined),
    observe: vi
      .fn()
      .mockResolvedValue({ url: "", title: "", scroll: { y: 0, h: 0, vh: 0 }, elements: [] }),
    act: vi.fn().mockResolvedValue({ ok: true }),
    captureScreenshot: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as BrowserSession;
}

describe("HyperpureAgent.readQuote", () => {
  it("reads via the engine's single-product read when no candidate read is available", async () => {
    const session = fakeSession();
    const agent = new HyperpureAgent({ session, homeUrl: "https://www.hyperpure.com" });

    const { chosen, candidates } = await agent.readQuote(item);
    expect(session.readProduct).toHaveBeenCalledWith(item);
    expect(chosen).toEqual(quote);
    expect(candidates).toEqual([quote]);
    expect(session.open).not.toHaveBeenCalled();
  });

  it("collects ranked candidates and chooses the best exact brand+size match (cheapest /kg)", async () => {
    // Three candidates: an exact Milky Mist 1 Kg (two prices) and a nearby Amul 1 Kg cheaper /kg.
    const exactDear: Quote = {
      ...quote,
      skuId: "mm-1kg-dear",
      title: "Milky Mist - Paneer, 1 Kg",
      pricePaise: 42000,
    };
    const exactCheap: Quote = {
      ...quote,
      skuId: "mm-1kg-cheap",
      title: "Milky Mist - Paneer, 1 Kg",
      pricePaise: 40000,
    };
    const nearbyCheapest: Quote = {
      ...quote,
      skuId: "amul-1kg",
      title: "Amul Paneer, 1 Kg",
      pricePaise: 38000,
    };
    const candidatesIn = [exactDear, nearbyCheapest, exactCheap];
    const session = fakeSession({
      readProductCandidates: vi.fn().mockResolvedValue(candidatesIn),
    });
    const agent = new HyperpureAgent({ session, homeUrl: "https://www.hyperpure.com" });

    const { chosen, candidates } = await agent.readQuote(item);
    // Exact brand+size match wins over the cheaper /kg nearby Amul; cheapest exact among ties.
    expect(chosen.skuId).toBe("mm-1kg-cheap");
    expect(chosen.matchKind).toBe("exact");
    expect(candidates).toEqual(candidatesIn);
    expect(session.readProduct).not.toHaveBeenCalled();
  });

  it("ensureReady opens the homepage", async () => {
    const session = fakeSession();
    const agent = new HyperpureAgent({ session, homeUrl: "https://www.hyperpure.com" });
    await agent.ensureReady();
    expect(session.open).toHaveBeenCalledWith("https://www.hyperpure.com", { hidden: false });
  });
});

describe("HyperpureAgent.search (direct URL navigation)", () => {
  it("navigates straight to the results URL (no typing, no synthetic Enter)", async () => {
    const session = fakeSession();

    await new HyperpureAgent({ session }).search(item);

    const url = (session.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/in/search/milky-mist-paneer-1-kg");
    expect(url).toContain("query=Milky%20Mist%20paneer%201%20kg");
    // Direct navigation → never types into a box and never needs the engine's self-healing search.
    expect(session.act).not.toHaveBeenCalled();
    expect(session.search).not.toHaveBeenCalled();
  });

  it("falls back to the engine search when the direct open throws", async () => {
    const session = fakeSession({ open: vi.fn().mockRejectedValue(new Error("navigation blocked")) });

    await new HyperpureAgent({ session }).search(item);

    expect(session.search).toHaveBeenCalledWith(item);
  });
});

describe("HyperpureAgent.addToCart (confirmed)", () => {
  // A real detail URL so addToCart opens it directly; the add logic itself is identical on a listing or
  // a detail page.
  const productUrl = "https://www.hyperpure.com/in/milky-mist-paneer-1-kg";
  const card = el({
    idx: 21,
    tag: "h3",
    name: "Milky Mist - Paneer, 1 Kg 1 kg | 5 (737) ₹399",
    bbox: [260, 200, 200, 60],
  });
  const addBtn = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });

  it("returns 'added' when the tile's ADD swaps to a quantity stepper", async () => {
    const before = obs([card, addBtn], productUrl);
    const after = obs(
      [
        card,
        el({ idx: 40, tag: "button", name: "−", bbox: [290, 240, 30, 30] }),
        el({ idx: 41, tag: "button", name: "+", bbox: [380, 240, 30, 30] }),
      ],
      productUrl,
    );
    const observe = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    const session = fakeSession({ observe });

    const result = await new HyperpureAgent({ session, cartUrl: "https://cart" }).addToCart({
      skuId: "HP-PANEER-1KG",
      qty: 1,
      productUrl,
      item,
    });

    expect(session.open).toHaveBeenCalledWith(productUrl, { hidden: false });
    expect(session.act).toHaveBeenCalledWith({ type: "click", idx: 31 });
    expect(result).toMatchObject({ status: "added", qty: 1, cartUrl: "https://cart" });
  });

  it("returns 'failed' (with the product link) when the add is NOT confirmed", async () => {
    const page = obs([card, addBtn], productUrl);
    const observe = vi.fn().mockResolvedValue(page); // nothing changes after the click
    const session = fakeSession({ observe });

    const result = await new HyperpureAgent({ session }).addToCart({
      skuId: "HP-PANEER-1KG",
      qty: 1,
      productUrl,
      item,
    });

    expect(result.status).toBe("failed");
    expect(result.productUrl).toBe(productUrl);
    expect(result.reason).toMatch(/not confirmed/i);
  });

  it("returns 'failed' (no ADD button) when the page has no add control", async () => {
    const page = obs([el({ idx: 1, tag: "div", name: "Something unrelated" })], productUrl);
    const observe = vi.fn().mockResolvedValue(page);
    const session = fakeSession({ observe });

    const result = await new HyperpureAgent({ session }).addToCart({
      skuId: "HP-PANEER-1KG",
      qty: 1,
      item,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/no ADD button/i);
    // The detail URL is derived from the SKU slug and still handed back for the manual fallback.
    expect(result.productUrl).toBe("https://www.hyperpure.com/in/hp-paneer-1kg");
  });
});

describe("HyperpureAgent site-memory (RAG)", () => {
  const productUrl = "https://www.hyperpure.com/in/milky-mist-paneer-1-kg";
  const card = el({ idx: 21, tag: "h3", name: "Milky Mist - Paneer, 1 Kg ₹399", bbox: [260, 200, 200, 60] });
  const addBtn = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });

  function confirmingSession(): BrowserSession {
    const before = obs([card, addBtn], productUrl);
    const after = obs(
      [
        card,
        el({ idx: 40, tag: "button", name: "−", bbox: [290, 240, 30, 30] }),
        el({ idx: 41, tag: "button", name: "+", bbox: [380, 240, 30, 30] }),
      ],
      productUrl,
    );
    const observe = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    return fakeSession({ observe });
  }

  it("writes back the product URL + ADD locator on a confirmed add", async () => {
    const memStore = new Map<string, string>();
    const memory = new SiteMemory("hyperpure", {
      storage: { getItem: (k) => memStore.get(k) ?? null, setItem: (k, v) => void memStore.set(k, v) },
    });
    const session = confirmingSession();

    await new HyperpureAgent({ session, memory }).addToCart({
      skuId: "HP-PANEER-1KG",
      qty: 1,
      productUrl,
      item,
    });

    expect(memory.recallProductUrl("paneer")?.url).toBe(productUrl);
    expect(memory.recallLocator("detail:addToCart")?.namePattern).toBe("add +");
  });

  it("reuses a learned product URL instead of the slug-derived one", async () => {
    const memory = new SiteMemory("hyperpure", {
      storage: { getItem: () => null, setItem: () => undefined },
    });
    memory.rememberProductUrl("paneer", productUrl, "Milky Mist Paneer 1 Kg");
    const session = confirmingSession();

    // No productUrl passed on the line — the agent should open the LEARNED url, not /in/hp-paneer-1kg.
    await new HyperpureAgent({ session, memory }).addToCart({
      skuId: "HP-PANEER-1KG",
      qty: 1,
      item,
    });

    expect(session.open).toHaveBeenCalledWith(productUrl, { hidden: false });
  });
});

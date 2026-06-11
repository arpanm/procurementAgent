import { describe, expect, it } from "vitest";
import type { SerializedElement } from "../automation/AutomationEngine";
import {
  cleanTitle,
  detectCredit,
  detectOtp,
  detectPayment,
  detectReloginNeeded,
  findCartRemoveControl,
  findNearbyPriceEl,
  findQuantitySelector,
  findResultCard,
  isProductHref,
  parseDeliveryDate,
  parseInStock,
  parseMrpPaise,
  parsePricePaise,
  parseStockCap,
  parseTotalPaise,
  readCartLines,
  skuIdFromHref,
} from "./selectors";

function el(over: Partial<SerializedElement>): SerializedElement {
  return {
    idx: 0,
    tag: "a",
    role: null,
    name: "",
    value: null,
    bbox: [0, 0, 0, 0],
    attrs: { type: null, name: null, href: null },
    ...over,
  };
}

describe("price parsing", () => {
  it("parses rupee symbol, commas and decimals into paise", () => {
    expect(parsePricePaise("₹250")).toBe(25000);
    expect(parsePricePaise("₹2,499.00")).toBe(249900);
    expect(parsePricePaise("Rs. 85")).toBe(8500);
    expect(parsePricePaise("INR 1,150.50")).toBe(115050);
    expect(parsePricePaise("₹19.99")).toBe(1999);
  });

  it("returns null when no currency amount is present", () => {
    expect(parsePricePaise("In stock · Delivery by Tomorrow")).toBeNull();
  });

  it("parses an MRP-labelled amount", () => {
    expect(parseMrpPaise("₹250 MRP ₹300")).toBe(30000);
    expect(parseMrpPaise("no mrp here")).toBeUndefined();
  });
});

describe("findResultCard", () => {
  const riceItem = {
    canonicalItemId: "rice",
    name: "rice",
    qty: 1,
    unit: "piece" as const,
    raw: "rice",
  };

  it("prefers a priced <div> tile over a priceless category header", () => {
    // Mirrors Hyperpure's live listing: a sidebar category ("Basmati & Biryani Rice") shares the
    // "rice" token but has no price, while the real product tile is a clickable <div> carrying ₹.
    const header = el({ idx: 12, tag: "div", role: null, name: "Basmati & Biryani Rice" });
    const tile = el({
      idx: 42,
      tag: "div",
      role: null,
      name: "Daawat - FS Resto Riz Basmati Rice, 5 Kg\n5 kg\n4.5\n(106)\n₹658\nat ₹131.6/kg\nADD",
    });
    const found = findResultCard([header, tile], riceItem);
    expect(found?.idx).toBe(42);
  });

  it("still matches an Amazon-style <a> product link", () => {
    const link = el({
      idx: 7,
      tag: "a",
      name: "India Gate Basmati Rice 1 kg ₹150",
      attrs: { type: null, name: null, href: "/dp/B0RICE" },
    });
    expect(findResultCard([link], riceItem)?.idx).toBe(7);
  });

  it("ignores Amazon filter links whose href (not text) carries the query", () => {
    // "Apply the filter Up to ₹200" has a price and an href containing "rice", but the visible text has
    // no "rice" token — it must not be picked over a real product card.
    const filter = el({
      idx: 29,
      tag: "a",
      role: "listitem",
      name: "Apply the filter Up to ₹200 to narrow results",
      attrs: { type: null, name: null, href: "/s?k=rice&rh=p_36%3A-20000" },
    });
    const product = el({
      idx: 88,
      tag: "a",
      name: "India Gate Basmati Rice, 1 kg ₹150",
      attrs: { type: null, name: null, href: "/dp/B0RICE" },
    });
    expect(findResultCard([filter, product], riceItem)?.idx).toBe(88);
  });

  it("correlates a price from a sibling node just below the title (same column)", () => {
    // Product title carries no price; the price sits directly below it in the tile. A far-away price
    // in another column must not win.
    const title = el({ idx: 50, tag: "a", name: "Daawat Basmati Rice 5kg", bbox: [120, 400, 200, 40] });
    const priceBelow = el({ idx: 51, tag: "span", name: "₹658", bbox: [120, 470, 80, 24] });
    const otherColumn = el({ idx: 60, tag: "span", name: "₹3,353", bbox: [900, 470, 80, 24] });
    expect(findNearbyPriceEl([title, priceBelow, otherColumn], title)?.idx).toBe(51);
  });

  it("ignores Amazon filter links whose VISIBLE text contains the query token", () => {
    // The real-world failure: "Apply the filter Chicken Coop to narrow results" literally contains
    // "chicken" and sits next to a price, so a plain token match would wrongly extract it as a product.
    const chickenItem = {
      raw: "chicken",
      canonicalItemId: "chicken",
      name: "chicken",
      qty: 1,
      unit: "kg" as const,
    };
    const filter = el({
      idx: 26,
      tag: "a",
      role: "listitem",
      name: "Apply the filter Chicken Coop to narrow results",
      attrs: { type: null, name: null, href: "/s?k=chicken&rh=p_36%3A20000-25000" },
    });
    const product = el({
      idx: 90,
      tag: "a",
      name: "Licious Chicken Breast Boneless 500 g ₹250",
      attrs: { type: null, name: null, href: "/dp/B0CHICK" },
    });
    expect(findResultCard([filter, product], chickenItem)?.idx).toBe(90);
    // And with no real product present, the filter link must NOT be returned.
    expect(findResultCard([filter], chickenItem)).toBeUndefined();
  });

  it("ignores controls (search box / ADD button)", () => {
    const input = el({ idx: 1, tag: "input", role: "searchbox", name: "rice", value: "rice" });
    const addBtn = el({ idx: 2, tag: "button", name: "ADD rice" });
    expect(findResultCard([input, addBtn], riceItem)).toBeUndefined();
  });

  const springOnion = {
    raw: "spring onion",
    canonicalItemId: "spring-onion",
    name: "spring onion",
    qty: 1,
    unit: "kg" as const,
  };

  it("prefers a fresh product over a sponsored, processed (dehydrated/flakes) variant", () => {
    // The real-world failure: "Sponsored Ad - SHROOTS Dehydrated Chopped Spring Onion Flakes" matched
    // all tokens and was extracted instead of fresh spring onion.
    const sponsoredFlakes = el({
      idx: 73,
      tag: "a",
      name: "Sponsored Ad - SHROOTS Dehydrated Chopped Spring Onion Flakes ₹225",
      attrs: { type: null, name: null, href: "/dp/B0F2TBHMBP" },
    });
    const fresh = el({
      idx: 90,
      tag: "a",
      name: "Fresho Spring Onion, 250 g ₹29",
      attrs: { type: null, name: null, href: "/dp/B0FRESH" },
    });
    expect(findResultCard([sponsoredFlakes, fresh], springOnion)?.idx).toBe(90);
  });

  it("defers (returns undefined) when the only match is a sponsored processed variant", () => {
    const sponsoredFlakes = el({
      idx: 73,
      tag: "a",
      name: "Sponsored Ad - SHROOTS Dehydrated Chopped Spring Onion Flakes ₹225",
      attrs: { type: null, name: null, href: "/dp/B0F2TBHMBP" },
    });
    expect(findResultCard([sponsoredFlakes], springOnion)).toBeUndefined();
  });

  it("does NOT penalise a processed term the user actually asked for", () => {
    const seedsItem = {
      raw: "tomato seeds",
      canonicalItemId: "tomato-seeds",
      name: "tomato seeds",
      qty: 1,
      unit: "piece" as const,
    };
    const seeds = el({
      idx: 5,
      tag: "a",
      name: "Premium Tomato Seeds Pack ₹99",
      attrs: { type: null, name: null, href: "/dp/B0SEED" },
    });
    expect(findResultCard([seeds], seedsItem)?.idx).toBe(5);
  });
});

describe("stock & delivery parsing", () => {
  it("reads in/out of stock from varied phrasings", () => {
    expect(parseInStock("In stock")).toBe(true);
    expect(parseInStock("Out of stock")).toBe(false);
    expect(parseInStock("Currently unavailable")).toBe(false);
    expect(parseInStock("Sold out")).toBe(false);
    expect(parseInStock("Add to cart")).toBe(true);
  });

  it("parses delivery phrases", () => {
    expect(parseDeliveryDate("· Delivery by Tomorrow")).toBe("Tomorrow");
    expect(parseDeliveryDate("· Get it by 12 Jun")).toBe("12 Jun");
    expect(
      parseDeliveryDate("Onion 10kg · ₹250 · In stock · Delivery by Today"),
    ).toBe("Today");
    expect(parseDeliveryDate("no delivery info")).toBeUndefined();
  });

  it("parses stock caps", () => {
    expect(parseStockCap("Only 3 left")).toBe(3);
    expect(parseStockCap("plenty")).toBeUndefined();
  });
});

describe("title & sku derivation", () => {
  it("cleans price/stock/delivery noise off the title", () => {
    expect(cleanTitle("Fresh Red Onion 10kg · ₹250 · In stock · Delivery by Tomorrow")).toBe(
      "Fresh Red Onion 10kg",
    );
    expect(cleanTitle("Fortune Refined Oil 5L ₹1,150 In stock")).toBe("Fortune Refined Oil 5L");
  });

  it("derives a sku id from an href, with a slug fallback", () => {
    expect(skuIdFromHref("/hp/p/HP-ONION-10KG", "x")).toBe("HP-ONION-10KG");
    expect(skuIdFromHref("/dp/B0ONION10?ref=abc", "x")).toBe("B0ONION10");
    expect(skuIdFromHref(null, "Fresh Onion 10kg")).toBe("fresh-onion-10kg");
  });

  it("extracts the ASIN from a buried href so the same product reads identically everywhere", () => {
    // Search card, product page and cart row carry DIFFERENT trailing ref=… tokens for the same ASIN.
    const fromCard = skuIdFromHref("/Amul-Fresh-Paneer-200g/dp/B078KT9RB1/ref=mp_s_a_1_1?dib=x", "t");
    const fromCart = skuIdFromHref("/dp/B078KT9RB1/ref=ox_sc_act_title_16", "t");
    expect(fromCard).toBe("B078KT9RB1");
    expect(fromCart).toBe("B078KT9RB1");
    expect(fromCard).toBe(fromCart);
  });
});

describe("findQuantitySelector", () => {
  it("finds a native quantity <select>", () => {
    const sel = el({ idx: 5, tag: "select", value: "1", attrs: { type: null, name: "quantity", href: null } });
    const other = el({ idx: 6, tag: "select", attrs: { type: null, name: "sort", href: null } });
    expect(findQuantitySelector([other, sel])?.idx).toBe(5);
    expect(findQuantitySelector([other])).toBeUndefined();
  });
});

describe("findCartRemoveControl", () => {
  it("finds a Delete/Remove control on a cart row", () => {
    const del = el({ idx: 3, tag: "input", name: "Delete", attrs: { type: "submit", name: "submit.delete", href: null } });
    const keep = el({ idx: 4, tag: "button", name: "Save for later", attrs: { type: "button", name: null, href: null } });
    expect(findCartRemoveControl([keep, del])?.idx).toBe(3);
    expect(findCartRemoveControl([keep])).toBeUndefined();
  });
});

describe("isProductHref", () => {
  it("accepts product detail links and rejects search/filter/auth chrome", () => {
    expect(isProductHref("/dp/B0PANEER1")).toBe(true);
    expect(isProductHref("/gp/product/B0OIL5L")).toBe(true);
    expect(isProductHref("/in/malai-paneer/HP-PANEER-1KG")).toBe(true);
    expect(isProductHref("/hp/p/HP-ONION-10KG")).toBe(true);
    expect(isProductHref(null)).toBe(false);
    expect(isProductHref("/s?k=paneer&rh=p_36%3A-20000")).toBe(false);
    expect(isProductHref("/ap/signin")).toBe(false);
  });
});

describe("readCartLines", () => {
  it("reads product rows (sku, title, qty, unit price) from a serialized cart page", () => {
    const rowA = el({
      idx: 10,
      tag: "a",
      name: "Amul Malai Paneer 1 kg",
      bbox: [40, 200, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0PANEER1" },
    });
    const priceA = el({ idx: 11, tag: "span", name: "₹399", bbox: [40, 230, 80, 24] });
    const qtyA = el({ idx: 12, tag: "span", name: "Qty: 5", bbox: [40, 230, 60, 24] });
    const rowB = el({
      idx: 20,
      tag: "a",
      name: "Fortune Refined Oil 5 L ₹1,199",
      bbox: [40, 320, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0OIL5L" },
    });

    const lines = readCartLines([rowA, priceA, qtyA, rowB]);
    expect(lines).toHaveLength(2);
    const paneer = lines.find((l) => l.skuId === "B0PANEER1")!;
    expect(paneer).toMatchObject({ title: "Amul Malai Paneer 1 kg", qty: 5, unitPricePaise: 39900 });
    const oil = lines.find((l) => l.skuId === "B0OIL5L")!;
    expect(oil).toMatchObject({ qty: 1, unitPricePaise: 119900 });
  });

  it("ignores chrome (search/filter links, unpriced links) and de-dupes a SKU", () => {
    const filter = el({
      idx: 1,
      tag: "a",
      name: "Apply the filter Up to ₹200",
      bbox: [0, 0, 100, 20],
      attrs: { type: null, name: null, href: "/s?k=paneer&rh=p_36%3A-20000" },
    });
    const rowA = el({
      idx: 10,
      tag: "a",
      name: "Amul Malai Paneer 1 kg ₹399",
      bbox: [40, 200, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0PANEER1" },
    });
    const rowDup = el({
      idx: 11,
      tag: "a",
      name: "Amul Malai Paneer 1 kg ₹399",
      bbox: [40, 200, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0PANEER1" },
    });
    const unpriced = el({
      idx: 12,
      tag: "a",
      name: "See more like this",
      bbox: [40, 600, 100, 20],
      attrs: { type: null, name: null, href: "/dp/B0OTHER" },
    });

    const lines = readCartLines([filter, rowA, rowDup, unpriced]);
    expect(lines).toHaveLength(1);
    expect(lines[0].skuId).toBe("B0PANEER1");
  });

  it("reads ONLY active-cart rows, not the recommendation carousel below it", () => {
    // The genuine cart line is stamped with an active-cart ref; the "buy it again" tiles are not.
    const active = el({
      idx: 10,
      tag: "a",
      name: "Amul Malai Paneer 1 kg ₹399",
      bbox: [40, 200, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0PANEER001/ref=ox_sc_act_title_1" },
    });
    const recoA = el({
      idx: 20,
      tag: "a",
      name: "Dragon Masters Book ₹211",
      bbox: [40, 700, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0BOOK00001/ref=cbc_bmsm_dp_1" },
    });
    const recoB = el({
      idx: 21,
      tag: "a",
      name: "World Map Poster ₹348",
      bbox: [40, 760, 300, 30],
      attrs: { type: null, name: null, href: "/dp/B0MAP000001/ref=cbc_bmsm_dp_2" },
    });

    const lines = readCartLines([active, recoA, recoB]);
    expect(lines).toHaveLength(1);
    expect(lines[0].skuId).toBe("B0PANEER001");
  });
});

describe("HITL & health detectors", () => {
  it("detects OTP fields", () => {
    expect(detectOtp([el({ tag: "input", name: "Enter OTP" })])).toBe(true);
    expect(detectOtp([el({ tag: "input", attrs: { type: "one-time-code", name: null, href: null } })])).toBe(
      true,
    );
    expect(detectOtp([el({ name: "Add to cart" })])).toBe(false);
    // Amazon shows "One-time purchase" (vs Subscribe & Save) on every card — must NOT read as OTP.
    expect(detectOtp([el({ name: "One-time purchase" })])).toBe(false);
    expect(detectOtp([el({ name: "Enter one-time password" })])).toBe(true);
  });

  it("detects payment and credit affordances", () => {
    expect(detectPayment([el({ tag: "button", name: "Pay now via UPI" })])).toBe(true);
    expect(detectCredit([el({ tag: "button", name: "Place order on credit" })])).toBe(true);
    expect(detectCredit([el({ tag: "button", name: "Place order" })])).toBe(false);
  });

  it("detects a logged-out / session-expired page", () => {
    expect(
      detectReloginNeeded([el({ tag: "input", attrs: { type: "password", name: null, href: null } })]),
    ).toBe(true);
    // A login prompt with no signed-in affordance is a real wall.
    expect(detectReloginNeeded([el({ tag: "button", name: "Sign in" })])).toBe(true);
    expect(detectReloginNeeded([el({ tag: "button", name: "Add to cart" })])).toBe(false);
  });

  it("does NOT trip relogin when a 'Sign in' link coexists with signed-in affordances", () => {
    // Mirrors Amazon's live homepage DOM: "Sign in" sits in the nav alongside "Your Orders"/"Your
    // Account", so the page is usable for search and must not be treated as an OTP/login wall.
    expect(
      detectReloginNeeded([
        el({ tag: "a", name: "Sign in ›" }),
        el({ tag: "a", name: "Your Orders" }),
        el({ tag: "a", name: "Your Account" }),
      ]),
    ).toBe(false);
  });

  it("reads an order total, preferring a total-labelled element", () => {
    expect(
      parseTotalPaise([el({ name: "Subtotal ₹100" }), el({ name: "Order total ₹635" })]),
    ).toBe(63500);
  });
});

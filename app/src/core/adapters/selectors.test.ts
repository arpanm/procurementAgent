import { describe, expect, it } from "vitest";
import type { SerializedElement } from "../automation/AutomationEngine";
import {
  cleanTitle,
  detectCredit,
  detectOtp,
  detectPayment,
  detectReloginNeeded,
  findNearbyPriceEl,
  findResultCard,
  parseDeliveryDate,
  parseInStock,
  parseMrpPaise,
  parsePricePaise,
  parseStockCap,
  parseTotalPaise,
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

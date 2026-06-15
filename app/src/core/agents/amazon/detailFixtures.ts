/**
 * Recorded / representative Amazon.in **product detail-page** observations, in the serialized
 * {@link Observation} shape the perceiver actually emits (a flat list of {@link SerializedElement}s, each
 * with `idx, tag, role, name, value, bbox:[x,y,w,h], attrs`).
 *
 * These mirror a real Amazon mobile (`amazon.in`) product page: a long title heading near the top, a
 * prominent buybox selling price with a struck-through MRP just beside it, an EMI line, the "Add to Cart"
 * / "Buy Now" affordances, and — lower down — a "Sponsored products related to this item" carousel whose
 * tiles carry *different* prices. The carousel is the trap: it is exactly the kind of off-buybox price
 * that made the search scrape read ₹99 instead of the true ₹237, so it exists here to prove the extractor
 * anchors on the buybox and ignores it.
 */
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";

/** Terse builder so the fixtures below read like a vertical page layout (top → bottom by `bbox.y`). */
function el(
  idx: number,
  tag: string,
  name: string,
  bbox: [number, number, number, number],
  extra: Partial<SerializedElement> = {},
): SerializedElement {
  return {
    idx,
    tag,
    role: extra.role ?? null,
    name,
    value: extra.value ?? null,
    bbox,
    attrs: extra.attrs ?? { type: null, name: null, href: null },
  };
}

/**
 * Milky Mist Paneer 500 g — in stock, true buybox price ₹237.00, struck MRP ₹260.00.
 * Page URL is the canonical detail page the agent navigates to from the search card's ASIN.
 */
export const AMZ_DETAIL_PANEER: Observation = {
  url: "https://www.amazon.in/Milky-Mist-Paneer-500g/dp/B018E0LQ8W/ref=mp_s_a_1_3?dib=eyJ2IjoiMSJ9&qid=1718200000&sr=8-3",
  title: "Milky Mist Paneer, 500 g: Amazon.in: Grocery & Gourmet Foods",
  scroll: { y: 0, h: 2400, vh: 720 },
  elements: [
    // --- top chrome ---
    el(0, "a", "Amazon", [12, 24, 96, 36], { attrs: { type: null, name: null, href: "/" } }),
    el(1, "input", "Search Amazon.in", [12, 64, 320, 40], {
      role: "searchbox",
      attrs: { type: "search", name: "field-keywords", href: null },
    }),
    el(2, "a", "Cart", [340, 64, 40, 40], { attrs: { type: null, name: null, href: "/gp/cart" } }),

    // --- product title (long heading near the top) ---
    el(10, "h1", "Milky Mist Paneer, 500 g", [16, 150, 360, 60], { role: "heading" }),
    el(11, "span", "Visit the Milky Mist Store", [16, 214, 220, 22]),
    el(12, "span", "4.3 out of 5 stars  (1,284 ratings)", [16, 240, 300, 20]),

    // --- buybox: current price (prominent), then the struck MRP and an EMI line ---
    el(20, "span", "₹237.00", [16, 320, 150, 44]),
    el(21, "span", "M.R.P.: ₹260.00", [180, 330, 160, 22]),
    el(22, "span", "(9% off)", [16, 372, 80, 20]),
    el(23, "span", "EMI starts at ₹12 per month. EMI options", [16, 400, 320, 20]),
    el(24, "span", "Inclusive of all taxes", [16, 424, 200, 20]),
    el(25, "span", "In stock", [16, 452, 120, 22]),
    el(26, "span", "FREE delivery Tomorrow, 14 Jun", [16, 478, 280, 20]),

    // --- the affordances the buybox price is anchored to ---
    el(30, "button", "Add to Cart", [16, 520, 360, 48], {
      role: "button",
      attrs: { type: "button", name: "add-to-cart", href: null },
    }),
    el(31, "button", "Buy Now", [16, 576, 360, 48], {
      role: "button",
      attrs: { type: "button", name: "buy-now", href: null },
    }),

    // --- product info further down ---
    el(40, "span", "About this item", [16, 700, 200, 24], { role: "heading" }),
    el(41, "span", "Fresh, soft paneer made from pure cow milk. Net weight 500 g.", [16, 730, 360, 40]),

    // --- THE TRAP: a sponsored carousel whose tiles carry DIFFERENT prices ---
    el(50, "span", "Sponsored products related to this item", [16, 1000, 340, 24], { role: "heading" }),
    el(51, "a", "Amul Malai Paneer 200 g  ₹99.00", [16, 1040, 170, 220], {
      attrs: { type: null, name: null, href: "/dp/B078KT9RB1" },
    }),
    el(52, "a", "Gowardhan Paneer 1 kg  ₹420.00", [200, 1040, 170, 220], {
      attrs: { type: null, name: null, href: "/dp/B07PANEER1K" },
    }),
    el(53, "span", "Sponsored", [16, 1004, 80, 18]),
  ],
};

/**
 * Out-of-stock variant: the buybox shows "Currently unavailable" and there is no Add-to-Cart / Buy-Now
 * affordance (Amazon replaces them with a disabled state / "Notify me"), so the extractor reads inStock
 * false even though prices are still rendered on the page.
 */
export const AMZ_DETAIL_OOS: Observation = {
  url: "https://www.amazon.in/Milky-Mist-Paneer-500g/dp/B018E0LQ8W/ref=mp_s_a_1_3?dib=eyJ2IjoiMSJ9&qid=1718200001&sr=8-3",
  title: "Milky Mist Paneer, 500 g: Amazon.in: Grocery & Gourmet Foods",
  scroll: { y: 0, h: 1600, vh: 720 },
  elements: [
    el(0, "a", "Amazon", [12, 24, 96, 36], { attrs: { type: null, name: null, href: "/" } }),
    el(1, "input", "Search Amazon.in", [12, 64, 320, 40], {
      role: "searchbox",
      attrs: { type: "search", name: "field-keywords", href: null },
    }),

    el(10, "h1", "Milky Mist Paneer, 500 g", [16, 150, 360, 60], { role: "heading" }),
    el(20, "span", "₹237.00", [16, 320, 150, 44]),
    el(21, "span", "M.R.P.: ₹260.00", [180, 330, 160, 22]),
    el(25, "span", "Currently unavailable.", [16, 400, 260, 24]),
    el(26, "span", "We don't know when or if this item will be back in stock.", [16, 428, 360, 40]),
    el(30, "button", "Notify me", [16, 500, 360, 48], {
      role: "button",
      attrs: { type: "button", name: "notify-me", href: null },
    }),
  ],
};

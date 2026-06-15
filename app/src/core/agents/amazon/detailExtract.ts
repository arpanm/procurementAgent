/**
 * Pure Amazon **product detail-page** extractor.
 *
 * The search-listing scrape proved unreliable — it once read a left-rail "Up to ₹99" filter tile as the
 * price of a product that is really ₹237. The Amazon agent now OPENS the product detail page and reads
 * the TRUE buybox price from there. This module is the pure read: given a serialized {@link Observation}
 * of a detail page, it returns the title, the dominant buybox selling price, the struck-through MRP, the
 * stock state and the pack size parsed from the title.
 *
 * It is deliberately **self-contained** (no import from the sibling `selectors` module) so it can be
 * edited in parallel without a merge race, and so the buybox heuristics here can evolve independently of
 * the listing heuristics. The only shared dependency is {@link parsePackSize}, which is the single source
 * of truth for size parsing across the app.
 */
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import { parsePackSize } from "../../pricing/packPricing";

/** The detail-page fields the Amazon agent reads off a product page (a subset of {@link Quote}). */
export interface AmazonDetail {
  title?: string;
  pricePaise?: number;
  mrpPaise?: number;
  inStock: boolean;
  packSize?: string;
}

// --- rupee parsing -----------------------------------------------------------

// A rupee amount: "₹237.00", "Rs. 1,459", "INR 99". Tolerant of commas and an optional 1-2 dp decimal.
const RUPEE_RE = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i;

function paiseFromRupees(rupees: string): number {
  const value = Number.parseFloat(rupees.replace(/,/g, ""));
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.round(value * 100);
}

/** First rupee amount in `text` as paise, or `null` when none is present. */
function parseRupeePaise(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = RUPEE_RE.exec(text);
  if (!m) return null;
  const paise = paiseFromRupees(m[1]);
  return Number.isFinite(paise) ? paise : null;
}

// --- element text helpers ----------------------------------------------------

function lower(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

/** All readable text on one element (visible label + value + accessible/name attr). */
function text(el: SerializedElement): string {
  return `${el.name} ${el.value ?? ""} ${el.attrs.name ?? ""}`;
}

function isButtonLike(el: SerializedElement): boolean {
  if (el.tag === "button" || el.role === "button") return true;
  if (el.tag === "input") {
    const type = lower(el.attrs.type);
    return type === "button" || type === "submit";
  }
  return false;
}

function centerOf(el: SerializedElement): { x: number; y: number } {
  const [x, y, w, h] = el.bbox;
  return { x: x + w / 2, y: y + h / 2 };
}

// --- price classification ----------------------------------------------------

// The struck-through list price / MRP. Amazon mobile renders it as "M.R.P.:" / "List Price:".
const MRP_LABEL_RE = /m\.?\s?r\.?\s?p\.?|list price|maximum retail|was\b/i;
// Noise that carries a ₹ amount but is NOT the selling price: EMI lines, savings/coupon banners, and
// left-rail "Up to ₹200" refinement copy. These must never be mistaken for the buybox price.
const PRICE_NOISE_RE =
  /emi|per month|\/\s?month|no cost|up to|save\b|\boff\b|coupon|cashback|exchange|delivery|shipping|you save|discount/i;
// Sponsored / "frequently bought" / recommendation carousel tiles that also carry prices.
const SPONSORED_RE =
  /sponsored|frequently bought|customers (?:also|who)|related products?|similar items?|you might also|bought together|compare with similar/i;

const BUYBOX_AFFORDANCE_RE = /add to cart|add to basket|add to bag|buy now|\bbuy\b/i;
const OUT_OF_STOCK_RE =
  /currently unavailable|out of stock|sold out|temporarily out of stock|unavailable|not available/i;
const IN_STOCK_RE = /\bin stock\b|\bavailable\b/i;

/** True for elements whose ₹ amount is the struck MRP / list price, not the current selling price. */
function isMrpLike(el: SerializedElement): boolean {
  return MRP_LABEL_RE.test(text(el));
}

/** True for elements whose ₹ amount is page noise (EMI, "Up to", savings, sponsored). */
function isNoise(el: SerializedElement): boolean {
  const t = text(el);
  return PRICE_NOISE_RE.test(t) || SPONSORED_RE.test(t);
}

// --- buybox anchor -----------------------------------------------------------

/**
 * The buybox is anchored on the "Add to Cart" / "Buy Now" affordance. The selling price sits right above
 * it. Anchoring price selection to this control is what makes us robust to the many other ₹ amounts on a
 * detail page (MRP, EMI, sponsored carousels). Returns the topmost matching affordance.
 */
function findBuyboxAnchor(els: readonly SerializedElement[]): SerializedElement | undefined {
  const buttons = els.filter(
    (el) =>
      isButtonLike(el) &&
      BUYBOX_AFFORDANCE_RE.test(text(el)) &&
      !OUT_OF_STOCK_RE.test(text(el)),
  );
  if (buttons.length === 0) return undefined;
  return [...buttons].sort((a, b) => a.bbox[1] - b.bbox[1])[0];
}

// --- title -------------------------------------------------------------------

function isHeadingLike(el: SerializedElement): boolean {
  return el.role === "heading" || /^h[1-3]$/i.test(el.tag);
}

/**
 * Pick the product title. On Amazon mobile the title is the long heading near the top of the page. We
 * prefer an explicit heading; failing that, the longest non-control, price-free text in the upper page.
 */
function pickTitle(els: readonly SerializedElement[]): string | undefined {
  const candidates = els.filter(
    (el) =>
      !isButtonLike(el) &&
      el.tag !== "input" &&
      el.tag !== "select" &&
      el.tag !== "textarea" &&
      el.name.trim().length > 0 &&
      parseRupeePaise(el.name) == null &&
      !isNoise(el),
  );
  const headings = candidates.filter(isHeadingLike);
  const pool = headings.length > 0 ? headings : candidates;
  if (pool.length === 0) return undefined;
  // Prefer a longer, more title-like name; break ties toward the top of the page.
  const best = [...pool].sort((a, b) => {
    const lenDiff = b.name.trim().length - a.name.trim().length;
    if (lenDiff !== 0) return lenDiff;
    return a.bbox[1] - b.bbox[1];
  })[0];
  return best?.name.trim() || undefined;
}

// --- price -------------------------------------------------------------------

/** Every element that carries a ₹ amount, tagged with its parsed paise value. */
function pricedElements(
  els: readonly SerializedElement[],
): { el: SerializedElement; paise: number }[] {
  const out: { el: SerializedElement; paise: number }[] = [];
  for (const el of els) {
    if (isButtonLike(el)) continue;
    const paise = parseRupeePaise(el.name);
    if (paise != null && paise > 0) out.push({ el, paise });
  }
  return out;
}

/**
 * The dominant current/buybox selling price. We start from every ₹ amount on the page, drop the MRP and
 * the noise (EMI/coupon/"Up to"/sponsored), then choose the candidate nearest the buybox affordance.
 * Without an anchor (e.g. a malformed page) we fall back to the most prominent (largest) priced element.
 */
function pickBuyboxPaise(els: readonly SerializedElement[]): number | undefined {
  const priced = pricedElements(els);
  if (priced.length === 0) return undefined;
  const sellable = priced.filter(({ el }) => !isMrpLike(el) && !isNoise(el));
  const pool = sellable.length > 0 ? sellable : priced;

  const anchor = findBuyboxAnchor(els);
  if (anchor) {
    const a = centerOf(anchor);
    const ranked = [...pool].sort((p, q) => {
      const cp = centerOf(p.el);
      const cq = centerOf(q.el);
      // The price sits just above the buy controls: weight horizontal misalignment more, and gently
      // penalise prices *below* the button (those are EMI/recommendation rows, not the headline price).
      const distP = Math.abs(cp.x - a.x) * 2 + Math.abs(cp.y - a.y) + (cp.y > a.y ? 240 : 0);
      const distQ = Math.abs(cq.x - a.x) * 2 + Math.abs(cq.y - a.y) + (cq.y > a.y ? 240 : 0);
      return distP - distQ;
    });
    return ranked[0]?.paise;
  }

  // No buy control: take the most prominent priced element (largest rendered area), then topmost.
  const ranked = [...pool].sort((p, q) => {
    const ap = p.el.bbox[2] * p.el.bbox[3];
    const aq = q.el.bbox[2] * q.el.bbox[3];
    if (aq !== ap) return aq - ap;
    return p.el.bbox[1] - q.el.bbox[1];
  });
  return ranked[0]?.paise;
}

// --- mrp ---------------------------------------------------------------------

/** The struck-through MRP / list price, when present and higher than the selling price. */
function pickMrpPaise(
  els: readonly SerializedElement[],
  pricePaise: number | undefined,
): number | undefined {
  let best: number | undefined;
  for (const el of els) {
    if (!isMrpLike(el)) continue;
    const paise = parseRupeePaise(el.name);
    if (paise == null || paise <= 0) continue;
    if (pricePaise != null && paise <= pricePaise) continue;
    if (best == null || paise > best) best = paise;
  }
  return best;
}

// --- stock -------------------------------------------------------------------

/**
 * In stock when there is an "Add to Cart" / "Buy Now" / "In stock" affordance and no "Currently
 * unavailable" / "Out of stock" copy anywhere on the page.
 */
function readInStock(els: readonly SerializedElement[]): boolean {
  const pageText = els.map(text).join("  ");
  if (OUT_OF_STOCK_RE.test(pageText)) return false;
  const hasAffordance =
    findBuyboxAnchor(els) != null || IN_STOCK_RE.test(pageText);
  return hasAffordance;
}

// --- public API --------------------------------------------------------------

/** Extract the detail-page fields from a serialized Amazon product page observation. */
export function extractAmazonDetail(obs: Observation): AmazonDetail {
  const els = obs.elements;
  const title = pickTitle(els);
  const pricePaise = pickBuyboxPaise(els);
  const mrpPaise = pickMrpPaise(els, pricePaise);
  const inStock = readInStock(els);
  const packSize = parsePackSize(title)?.raw;
  return { title, pricePaise, mrpPaise, inStock, packSize };
}

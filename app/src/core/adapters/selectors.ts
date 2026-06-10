/**
 * Serialized-element matchers & robust text parsers for the site adapters
 * (PROCURE_COPILOT_PLAN.md §3.5.4, §3.5.7, §3.5.11).
 *
 * The `WebViewAutomationEngine` hands each playbook step a list of `SerializedElement`s — the only
 * thing the perceiver emits. So adapter "selectors" are not CSS; they are pure predicates over the
 * serialized fields (`tag`, `role`, `name`, `value`, `attrs`). Every helper here is a pure function
 * with no DOM dependency, which keeps playbooks deterministic and unit-testable, and lets a step
 * return `null` (defer to the Claude-grounded backend) the moment it loses confidence.
 *
 * Parsing is intentionally forgiving: Hyperpure and Amazon render prices, stock and delivery in many
 * shapes (`₹250`, `₹2,499.00`, `Rs. 85`, "In stock"/"Out of stock", "Delivery by …"/"Get it by …").
 */
import type { SerializedElement } from "../automation/AutomationEngine";
import type { RequestedItem } from "../domain/types";

export type Elements = readonly SerializedElement[];

// --- low-level predicates ----------------------------------------------------

function lower(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

/** All human-readable text we can match against for one element. */
function haystack(el: SerializedElement): string {
  return lower(`${el.name} ${el.value ?? ""} ${el.attrs.name ?? ""} ${el.attrs.href ?? ""}`);
}

export function isLink(el: SerializedElement): boolean {
  return el.tag === "a" || el.role === "link";
}

export function isButton(el: SerializedElement): boolean {
  if (el.tag === "button" || el.role === "button") return true;
  if (el.tag === "input") {
    const type = lower(el.attrs.type);
    return type === "button" || type === "submit";
  }
  return false;
}

function isTextField(el: SerializedElement): boolean {
  if (el.role === "searchbox" || el.role === "textbox" || el.role === "combobox") return true;
  if (el.tag === "input") {
    const type = lower(el.attrs.type);
    return type === "" || type === "search" || type === "text";
  }
  return el.tag === "textarea";
}

// --- search ------------------------------------------------------------------

const SEARCH_HINT = /search|find|khojo|खोज/i;

/** Find the search input. Prefers an explicit `searchbox` role, then a searchish text field. */
export function findSearchbox(elements: Elements): SerializedElement | undefined {
  const byRole = elements.find((el) => el.role === "searchbox");
  if (byRole) return byRole;
  return elements.find(
    (el) =>
      isTextField(el) &&
      !isButton(el) &&
      (SEARCH_HINT.test(el.name) || SEARCH_HINT.test(el.attrs.name ?? "")),
  );
}

/**
 * Find the button/affordance that submits a search query. We match on a search hint in the visible
 * or `name`-attribute text rather than `type="submit"`, because an HTML `<button>` defaults to
 * `type="submit"` and that would match every button on the page (add-to-cart included).
 */
export function findSearchSubmit(elements: Elements): SerializedElement | undefined {
  return elements.find(
    (el) =>
      isButton(el) && (SEARCH_HINT.test(el.name) || SEARCH_HINT.test(el.attrs.name ?? "")),
  );
}

// --- result cards ------------------------------------------------------------

/** Split a normalized item name into the significant tokens we expect to see on a card. */
function itemTokens(item: RequestedItem): string[] {
  return lower(item.name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/**
 * Text used to judge product relevance — visible label + value + accessible name, but NOT `href`.
 * Amazon's left-rail filter links ("Apply the filter Up to ₹200…") carry the search query in their
 * href (`/s?k=rice&rh=…`); including href would let those priced nav links masquerade as the product.
 */
function cardText(el: SerializedElement): string {
  return lower(`${el.name} ${el.value ?? ""} ${el.attrs.name ?? ""}`);
}

function scoreCard(el: SerializedElement, item: RequestedItem): number {
  const text = cardText(el);
  const tokens = itemTokens(item);
  if (tokens.length === 0) return 0;
  let score = 0;
  if (text.includes(lower(item.name))) score += 3;
  for (const token of tokens) if (text.includes(token)) score += 1;
  // All meaningful tokens must be present for a confident match.
  if (tokens.some((token) => !text.includes(token))) return 0;
  // A readable price is the strongest "this is a real product tile" signal — it lets a priced tile beat
  // a same-tokens-but-priceless sidebar category header (e.g. "Basmati & Biryani Rice") on listings
  // where the clickable card is a <div>, not an <a>.
  if (parsePricePaise(el.name) != null) score += 5;
  const qtyUnit = `${item.qty}${lower(item.unit)}`;
  if (text.includes(qtyUnit) || text.includes(`${item.qty} ${lower(item.unit)}`)) score += 1;
  // Brand/variant/pack-size are preference signals (not mandatory): when the card shows the brand,
  // variant or the requested pack size, prefer it so "India Gate basmati 1kg" beats a generic rice.
  if (item.brand && text.includes(lower(item.brand))) score += 2;
  if (item.variant && text.includes(lower(item.variant))) score += 1;
  if (item.packSize) {
    const packCompact = lower(item.packSize).replace(/\s+/g, "");
    if (text.replace(/\s+/g, "").includes(packCompact)) score += 1;
  }
  return score;
}

/**
 * Find the best result card matching the requested item. On Amazon the card is an `<a>`; on Hyperpure
 * the clickable tile is a `<div>` (title + weight + price + ADD), so we consider any non-control element
 * and let the price bonus in {@link scoreCard} steer us to a real priced tile over a category header.
 * Returns `undefined` when nothing matches confidently, so the caller can defer to the backend.
 */
export function findResultCard(
  elements: Elements,
  item: RequestedItem,
): SerializedElement | undefined {
  let best: SerializedElement | undefined;
  let bestScore = 0;
  for (const el of elements) {
    // Controls (search box, ADD button) are not product cards; everything else can be a tile.
    if (isButton(el)) continue;
    if (el.tag === "input" || el.tag === "textarea" || el.tag === "select") continue;
    const score = scoreCard(el, item);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Find a price for a product card whose own text has none. On Amazon/Hyperpure the title and price live
 * in sibling nodes, so we look for the nearest priced element in the same column (similar left edge),
 * preferring one just below the title — that's where the price sits in a product tile. Returns the
 * element so the caller can read MRP/stock from the same node.
 */
export function findNearbyPriceEl(
  elements: Elements,
  card: SerializedElement,
): SerializedElement | undefined {
  const [cx, cy] = [card.bbox[0], card.bbox[1]];
  let best: SerializedElement | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const el of elements) {
    if (el.idx === card.idx) continue;
    if (parsePricePaise(el.name) == null) continue;
    const dx = el.bbox[0] - cx;
    const dy = el.bbox[1] - cy;
    // Same column (left edges within ~220px) and vertically close (price typically just below title).
    if (Math.abs(dx) > 220) continue;
    if (dy < -120 || dy > 360) continue;
    // Weight horizontal misalignment more, and prefer prices below (dy >= 0) over above.
    const dist = Math.abs(dx) * 2 + Math.abs(dy) + (dy < 0 ? 200 : 0);
    if (dist < bestDist) {
      best = el;
      bestDist = dist;
    }
  }
  return best;
}

const ADD_TO_CART = /add to cart|add to basket|add to bag|\badd\b|buy now/i;

/**
 * Find an "add to cart" control. When `skuId` is given we require the control to reference that SKU
 * (via its `name` attribute or href) so we click the right card's button on a multi-result page.
 */
export function findAddToCart(
  elements: Elements,
  skuId?: string,
): SerializedElement | undefined {
  const candidates = elements.filter(
    (el) => isButton(el) && (ADD_TO_CART.test(el.name) || ADD_TO_CART.test(el.attrs.name ?? "")),
  );
  if (skuId) {
    const needle = lower(skuId);
    return candidates.find((el) => haystack(el).includes(needle));
  }
  return candidates[0];
}

// --- cart / checkout ---------------------------------------------------------

const CART_LINK = /\bcart\b|\bbasket\b|\bbag\b/i;

export function findCartLink(elements: Elements): SerializedElement | undefined {
  return elements.find((el) => isLink(el) && CART_LINK.test(el.name));
}

const CHECKOUT = /checkout|proceed to (?:buy|pay|checkout)|place order|continue/i;

export function findCheckoutButton(elements: Elements): SerializedElement | undefined {
  return elements.find(
    (el) =>
      (isButton(el) || isLink(el)) &&
      (CHECKOUT.test(el.name) || CHECKOUT.test(el.attrs.name ?? "")),
  );
}

// --- robust text parsers -----------------------------------------------------

const CURRENCY = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/gi;

function paiseFromRupeeString(rupees: string): number {
  const normalized = rupees.replace(/,/g, "");
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.round(value * 100);
}

/** Parse the first currency amount in `text` into paise, or `null` when none is present. */
export function parsePricePaise(text: string): number | null {
  CURRENCY.lastIndex = 0;
  const match = CURRENCY.exec(text);
  if (!match) return null;
  const paise = paiseFromRupeeString(match[1]);
  return Number.isFinite(paise) ? paise : null;
}

/** Parse an explicitly MRP-labelled amount into paise, if shown (used for strikethrough MRP). */
export function parseMrpPaise(text: string): number | undefined {
  const match = /mrp\s*:?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  if (!match) return undefined;
  const paise = paiseFromRupeeString(match[1]);
  return Number.isFinite(paise) ? paise : undefined;
}

const OUT_OF_STOCK = /out[\s-]?of[\s-]?stock|sold[\s-]?out|unavailable|currently unavailable|notify me/i;
const IN_STOCK = /\bin[\s-]?stock\b|\bavailable\b|add to cart/i;

/** Best-effort stock read from a card's text. Defaults to in-stock when no signal is present. */
export function parseInStock(text: string): boolean {
  if (OUT_OF_STOCK.test(text)) return false;
  if (IN_STOCK.test(text)) return true;
  return true;
}

/** Parse "only N left" style caps, if shown. */
export function parseStockCap(text: string): number | undefined {
  const match = /only\s+(\d+)\s+left/i.exec(text);
  if (!match) return undefined;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

const DELIVERY = /(?:delivery by|get it by|delivery on|arrives by|delivery:)\s*([^·|•\n]+?)\s*(?:[·|•]|₹|in stock|out of stock|add to cart|$)/i;

/** Parse the human delivery phrase ("Tomorrow", "12 Jun", …) into a string, if shown. */
export function parseDeliveryDate(text: string): string | undefined {
  const match = DELIVERY.exec(text);
  if (!match) return undefined;
  const value = match[1].trim();
  return value.length > 0 ? value : undefined;
}

/** Parse a platform minimum-order-value, if shown ("MOV ₹500", "Min order ₹500"). */
export function parseMovPaise(text: string): number | undefined {
  const match = /(?:mov|min(?:imum)?(?:\s+order)?(?:\s+value)?)\s*:?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(
    text,
  );
  if (!match) return undefined;
  const paise = paiseFromRupeeString(match[1]);
  return Number.isFinite(paise) ? paise : undefined;
}

/** Derive a stable SKU id from a product href; falls back to a slug of the title. */
export function skuIdFromHref(href: string | null | undefined, fallbackTitle: string): string {
  if (href) {
    const path = href.split(/[?#]/)[0];
    const segments = path.split("/").filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  return fallbackTitle
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "unknown-sku";
}

/** Strip price/stock/delivery noise to recover a clean product title. */
export function cleanTitle(name: string): string {
  const cut = name.split(
    /\s*[·|•]\s*|₹|\brs\.?\b|\binr\b|\bmrp\b|\bin[\s-]?stock\b|\bout[\s-]?of[\s-]?stock\b|\bdelivery\b|\bget it\b/i,
  )[0];
  const title = (cut ?? name).trim();
  return title.length > 0 ? title : name.trim();
}

// --- HITL / health detectors -------------------------------------------------

// "one-time" only signals OTP when paired with code/password/pin; bare "One-time purchase" (Amazon
// Subscribe & Save) must NOT be read as an OTP field.
const OTP = /\botp\b|one[\s-]?time[\s-]?(?:pass(?:word|code)|code|pin)\b|verification code|enter the code/i;
const PAYMENT = /\bpayment\b|pay now|proceed to pay|\bupi\b|card number|net\s?banking|add card/i;
const CREDIT = /pay (?:later|on credit)|place order on credit|credit available|pay using credit|\bon credit\b|buy on credit/i;
const RELOGIN = /\b(?:sign[\s-]?in|signin|log[\s-]?in|login|session (?:expired|timed out)|please (?:sign|log) in|re-?login|your session)\b/i;
/**
 * Affordances that only appear once you're signed in (or that a logged-in shell always shows). Used to
 * suppress the relogin false-positive: a "Sign in" link sits in the nav of a perfectly authenticated
 * Amazon/Hyperpure page, so a bare login hint must NOT be treated as a login wall when these are present.
 */
const LOGGED_IN_AFFORDANCE = /\b(?:log\s?out|sign\s?out|your orders|my orders|returns & orders|your account|my account|account & lists|wishlist)\b/i;

export function detectOtp(elements: Elements): boolean {
  return elements.some((el) => OTP.test(haystack(el)) || lower(el.attrs.type) === "one-time-code");
}

export function detectPayment(elements: Elements): boolean {
  return elements.some((el) => PAYMENT.test(el.name) || PAYMENT.test(el.attrs.name ?? ""));
}

export function detectCredit(elements: Elements): boolean {
  return elements.some((el) => CREDIT.test(haystack(el)));
}

/**
 * Detect a logged-out / session-expired page so the adapter can surface a re-login need rather than
 * thrash against a page with no products (§9.2 session-expired case).
 */
export function detectReloginNeeded(elements: Elements): boolean {
  // A visible password field is an unambiguous logged-out signal.
  const hasPasswordField = elements.some((el) => lower(el.attrs.type) === "password");
  if (hasPasswordField) return true;
  const hasLoginPrompt = elements.some(
    (el) => RELOGIN.test(el.name) || RELOGIN.test(el.attrs.name ?? ""),
  );
  if (!hasLoginPrompt) return false;
  // "Sign in" links live in the nav of logged-in pages too (verified against Amazon's live DOM, where
  // "Sign in" coexists with "Your Orders"/"Your Account"). Only call it a wall when the page shows a
  // login prompt AND none of the signed-in affordances — otherwise we'd wrongly trip OTP before search.
  const hasLoggedInAffordance = elements.some(
    (el) =>
      LOGGED_IN_AFFORDANCE.test(el.name) || LOGGED_IN_AFFORDANCE.test(el.attrs.name ?? ""),
  );
  return !hasLoggedInAffordance;
}

const STRONG_TOTAL = /grand total|order total|total payable|amount payable|net payable|to pay/i;
const SUBTOTAL = /sub[\s-]?total/i;

/**
 * Read an order/cart total from the elements. Prefers an explicit "order/grand total" label, then a
 * plain "total" that is not a "subtotal", then the first currency amount as a last resort.
 */
export function parseTotalPaise(elements: Elements): number {
  for (const el of elements) {
    if (STRONG_TOTAL.test(el.name)) {
      const paise = parsePricePaise(el.name);
      if (paise != null) return paise;
    }
  }
  for (const el of elements) {
    if (/total/i.test(el.name) && !SUBTOTAL.test(el.name)) {
      const paise = parsePricePaise(el.name);
      if (paise != null) return paise;
    }
  }
  for (const el of elements) {
    const paise = parsePricePaise(el.name);
    if (paise != null) return paise;
  }
  return 0;
}

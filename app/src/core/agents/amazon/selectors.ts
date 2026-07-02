/**
 * Amazon-specific selectors — pure functions over a serialized DOM (PROCURE_COPILOT_PLAN.md §3.5.4).
 *
 * Part of the per-platform-agent split: this module owns ONLY the Amazon-relevant slice of the shared
 * `core/adapters/selectors.ts` logic (ASIN parsing, product-href detection, result-card scoring), with
 * the Hyperpure-specific bits dropped. Every helper is a pure function over the serialized fields
 * (`tag`, `role`, `name`, `value`, `attrs`) the perceiver emits — no DOM dependency, no side effects,
 * and no cross-imports from sibling agent modules — so playbooks stay deterministic and unit-testable.
 */
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import type { RequestedItem } from "../../domain/types";

// --- low-level helpers -------------------------------------------------------

function lower(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

function isLink(el: SerializedElement): boolean {
  return el.tag === "a" || el.role === "link";
}

/**
 * Text used to judge product relevance — visible label + value + accessible name, but NOT `href`.
 * Amazon's left-rail filter links ("Apply the filter Up to ₹200…") carry the search query in their
 * href (`/s?k=rice&rh=…`); including href would let those priced nav links masquerade as the product.
 */
function cardText(el: SerializedElement): string {
  return lower(`${el.name} ${el.value ?? ""} ${el.attrs.name ?? ""}`);
}

/** Split a normalized item name into the significant tokens we expect to see on a card. */
function itemTokens(item: RequestedItem): string[] {
  return lower(item.name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

// --- ASIN / product-URL parsing ----------------------------------------------

/**
 * Amazon's stable product id (ASIN) lives right after `/dp/`, `/gp/product/`, `/dp/product/`, etc.
 * A 10-char alphanumeric id. We also accept it as an explicit `?ASIN=`/`&ASIN=` query parameter.
 */
const ASIN_PATH_RE =
  /\/(?:dp|dp\/product|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})(?:[/?#]|$)/i;
const ASIN_QUERY_RE = /[?&]ASIN(?:\.\d+)?=([A-Z0-9]{10})\b/i;

/**
 * Extract a 10-char ASIN from a full product URL or any href that carries one (`/dp/<ASIN>`,
 * `/gp/product/<ASIN>`, `/dp/product/<ASIN>`, or a `?ASIN=` query). Returns the upper-cased id, or
 * `null` when none is present. The ASIN is identical everywhere the product appears, so it drives
 * Amazon's server-side cart-add endpoint and SKU-level verification reliably.
 */
export function asinFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = ASIN_PATH_RE.exec(url);
  if (path) return path[1].toUpperCase();
  const query = ASIN_QUERY_RE.exec(url);
  if (query) return query[1].toUpperCase();
  return null;
}

const DETAIL_URL_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\//i;

/** True for an Amazon product *detail* URL (`/dp/…`, `/gp/product/…`). */
export function isAmazonDetailUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return DETAIL_URL_RE.test(url);
}

/** Search/refinement/auth links we must never mistake for a product detail page. */
const NON_PRODUCT_HREF_RE = /[?&]rh=|[?&]k=|\/s\?|\/s\/|\/gp\/bestsellers|signin|\/ap\//i;

/**
 * True when an href points at a single product's detail page (not a search/filter/auth chrome link).
 * Amazon's left-rail refinements (`/s?k=rice&rh=…`) carry the query token and a price, so we gate on
 * the `/dp/…`-style detail path AND the absence of a search/refinement/auth marker.
 */
export function isAmazonProductHref(href: string | null | undefined): boolean {
  if (!href) return false;
  if (NON_PRODUCT_HREF_RE.test(href)) return false;
  return isAmazonDetailUrl(href) || ASIN_QUERY_RE.test(href);
}

// --- nav / refinement chrome -------------------------------------------------

/**
 * Amazon's left-rail refinement links read like products: "Apply the filter Chicken Coop to narrow
 * results" literally contains the query token in its VISIBLE text (so a token match alone can't reject
 * it) and a nearby price element lets it masquerade as a real tile. These never lead to a SKU, so we
 * reject them by their unmistakable nav phrasing.
 */
const FILTER_CHROME = /\bapply the filter\b|\bnarrow results\b|\bsort by\b|\bdid you mean\b/i;

/** True for nav/refinement chrome (Amazon filter links, sort controls) that is never a buyable product. */
function isNonProductChrome(el: SerializedElement): boolean {
  if (FILTER_CHROME.test(cardText(el))) return true;
  // A search-refinement link (`/s?k=…&rh=…`) is a filter, not a product detail page (`/dp/…`).
  if (isLink(el)) {
    const href = lower(el.attrs.href);
    if (href && /[?&]rh=/.test(href) && !isAmazonDetailUrl(href)) return true;
  }
  return false;
}

// --- relevance penalties -----------------------------------------------------

/** Ad tiles Amazon injects into results — almost never the right buy and often an unrelated variant. */
const SPONSORED_RE = /\bsponsored\b/i;
/**
 * Processed / non-fresh / non-grocery variants a keyword search drags in (search "spring onion" →
 * "Dehydrated Chopped Spring Onion Flakes"; "tomato" → "tomato seeds"/"ketchup"). When the requested
 * name doesn't itself ask for these, they're the wrong product, so we penalise rather than hard-reject.
 */
const PROCESSED_VARIANT_RE =
  /\b(dehydrated|dried|freeze[\s-]?dried|flakes?|powder|paste|pickle|sauce|ketchup|seeds?|sapling|plant|combo|kit)\b/gi;

const CURRENCY = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i;

function hasPrice(text: string): boolean {
  return CURRENCY.test(text);
}

/**
 * Score one element as a candidate Amazon product card. Returns 0 (reject) unless the element is a
 * product-detail href, is not nav/refinement chrome, and carries every meaningful token of the
 * requested item's name. Brand/variant/pack-size and a readable price are preference bonuses; sponsored
 * ad tiles and processed/non-fresh variants the user didn't ask for are penalised.
 */
function scoreCard(el: SerializedElement, item: RequestedItem): number {
  // Amazon cards are `<a href="/dp/…">` tiles. A non-product href is a filter/nav link, never a buy.
  if (!isAmazonProductHref(el.attrs.href)) return 0;
  if (isNonProductChrome(el)) return 0;

  const text = cardText(el);
  const tokens = itemTokens(item);
  if (tokens.length === 0) return 0;

  let score = 0;
  if (text.includes(lower(item.name))) score += 3;
  for (const token of tokens) if (text.includes(token)) score += 1;
  // All meaningful tokens must be present for a confident match.
  if (tokens.some((token) => !text.includes(token))) return 0;

  // A readable price is a strong "this is a real product tile" signal.
  if (hasPrice(text)) score += 5;

  const qtyUnit = `${item.qty}${lower(item.unit)}`;
  if (text.includes(qtyUnit) || text.includes(`${item.qty} ${lower(item.unit)}`)) score += 1;
  // Brand/variant/pack-size are preference signals (not mandatory).
  if (item.brand && text.includes(lower(item.brand))) score += 2;
  if (item.variant && text.includes(lower(item.variant))) score += 1;
  if (item.packSize) {
    const packCompact = lower(item.packSize).replace(/\s+/g, "");
    if (text.replace(/\s+/g, "").includes(packCompact)) score += 1;
  }

  // Relevance penalties: sponsored ad tiles and processed/non-fresh variants the user didn't ask for.
  if (SPONSORED_RE.test(text)) score -= 5;
  const requested = lower(`${item.name} ${item.variant ?? ""} ${item.packSize ?? ""}`);
  for (const m of text.matchAll(PROCESSED_VARIANT_RE)) {
    if (!requested.includes(lower(m[0]))) score -= 4;
  }
  return score;
}

/**
 * Pick the best product-link element on an Amazon search-results page for the requested item. The
 * winner must be a product-detail href, must not be filter/nav chrome, and must carry every meaningful
 * token of the item name; sponsored + processed-variant titles are penalised. Returns `null` when
 * nothing scores acceptably, so the caller can defer to the Claude-grounded backend.
 */
export function findAmazonResultCard(
  obs: Observation,
  item: RequestedItem,
): SerializedElement | null {
  let best: SerializedElement | null = null;
  let bestScore = 0;
  for (const el of obs.elements) {
    const score = scoreCard(el, item);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

// --- quantity control --------------------------------------------------------

/**
 * Find Amazon's detail-page quantity `<select>` (native `id="quantity" name="quantity"`, or the
 * accessible "Quantity" combobox). Amazon's "Add to Cart" adds however many the dropdown has selected,
 * so the agent must set this to the requested count — a bare add places exactly 1. Returns `null` when
 * the page has no quantity control (e.g. a stepper-only layout), so the caller reports the honest 1.
 */
export function findQuantitySelect(obs: Observation): SerializedElement | null {
  for (const el of obs.elements) {
    const name = lower(el.attrs.name);
    const isSelectish = el.tag === "select" || el.role === "combobox" || el.role === "listbox";
    if (!isSelectish) continue;
    if (name === "quantity" || name.includes("quantity") || lower(el.name).includes("quantity")) {
      return el;
    }
  }
  return null;
}

// --- product URL resolution --------------------------------------------------

/**
 * Resolve a result-card element's href to an absolute product URL against the page URL. When an ASIN
 * is present we prefer the clean canonical `/dp/<ASIN>` form (dropping per-placement `ref=…` tracking
 * tokens that differ between the search card and the cart row); otherwise the absolutised href is
 * returned. Returns `undefined` when the element has no usable href.
 */
export function amazonProductUrl(el: SerializedElement, pageUrl: string): string | undefined {
  const href = el.attrs.href;
  if (!href) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(href, pageUrl);
  } catch {
    return undefined;
  }
  const asin = asinFromUrl(resolved.href);
  if (asin) return `${resolved.origin}/dp/${asin}`;
  return resolved.href;
}

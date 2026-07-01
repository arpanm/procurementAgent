/**
 * Hyperpure-specific selectors (pure functions over an {@link Observation}).
 *
 * These exist because the shared playbook/Claude-self-heal path was unreliable on Hyperpure:
 *  - SEARCH typed into a hardcoded element handle (`@7`) that is NOT the search box, so the first search
 *    of a run never navigated off the homepage and tripped the circuit breaker (the "onion not found" bug —
 *    the search never ran, so extraction never had a results page to read).
 *  - ADD-to-cart blindly clicked a model-chosen handle and reported success on any non-throw, so the item
 *    silently never entered the cart (the "cart empty after add" bug).
 *
 * The serializer (see `injected/domSerializer.ts`) only exposes `name` (aria-label / placeholder /
 * innerText), `attrs.type`, `role` and `bbox` — no class/id — so every matcher here works off visible
 * text + spatial geometry, which is exactly what survives Hyperpure's minified, hashed-class React DOM.
 */
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import type { RequestedItem } from "../../domain/types";

/** A Hyperpure search-results page, e.g. `https://www.hyperpure.com/in/search/onion?...`. */
export function isHyperpureSearchUrl(url: string | undefined | null): boolean {
  return !!url && /\/in\/search\//i.test(url);
}

/** Lowercase, hyphen-join a free-text string into a Hyperpure URL path segment ("Onion (Big), 10 Kg" → "onion-big-10-kg"). */
function slugSegment(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the Hyperpure search-RESULTS URL for a query. Hyperpure routes search through a deterministic URL
 * (`/in/search/<slug>?query=<q>`), so we navigate straight to it instead of typing into the box and hoping
 * the synthetic Enter key fires the autosuggest navigation (which it doesn't reliably — the cause of the
 * "clicks search but never enters the term / opens the URL" bug). The `referenceType` mirrors the param the
 * site itself adds for an Enter-submitted search.
 */
export function hyperpureSearchUrl(query: string): string {
  const q = query.trim();
  const slug = slugSegment(q) || "all";
  return (
    `https://www.hyperpure.com/in/search/${slug}` +
    `?type=SEARCH&query=${encodeURIComponent(q)}&referenceType=autosuggest_enter_before_result`
  );
}

/**
 * Build a Hyperpure product DETAIL URL from a slug/SKU id. The engine's skuId is `slugify(title)` and
 * Hyperpure's product path is exactly that slug ("Milky Mist - Paneer, 1 Kg" → `/in/milky-mist-paneer-1-kg`),
 * so we can open the single-product page (clean ADD button) without needing an anchor href off the listing
 * — Hyperpure tiles are `<div>`s with no href, so there's nothing to capture there anyway.
 */
export function hyperpureProductUrl(slugOrSku: string): string {
  return `https://www.hyperpure.com/in/${slugSegment(slugOrSku)}`;
}

/**
 * A Hyperpure product DETAIL page, e.g. `https://www.hyperpure.com/in/milky-mist-paneer-1-kg`.
 * Excludes the home/search/cart/account routes (those are not single-product pages).
 */
export function isHyperpureProductUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const m = /hyperpure\.com\/in\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/i.exec(url);
  if (!m) return false;
  const seg = m[1].toLowerCase();
  return !["search", "cart", "checkout", "account", "orders", "products"].includes(seg);
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function isInputLike(el: SerializedElement): boolean {
  return (
    el.tag === "input" ||
    el.tag === "textarea" ||
    el.role === "searchbox" ||
    el.role === "textbox" ||
    el.role === "combobox"
  );
}

function isClickable(el: SerializedElement): boolean {
  return (
    el.tag === "button" ||
    el.tag === "a" ||
    el.tag === "input" ||
    el.role === "button" ||
    el.role === "link"
  );
}

/**
 * Find Hyperpure's search box. Hyperpure renders one text input with placeholder
 * "Search items or categories" (surfaced as `name` by the serializer) — we score on that text, an
 * explicit `type="search"`, and combobox/searchbox roles so we land on the real box instead of an
 * unrelated input (location, login). Returns the top-most match, or null to let the caller fall back.
 */
export function findHyperpureSearchInput(obs: Observation): SerializedElement | null {
  const scored = obs.elements
    .filter(isInputLike)
    .map((el) => {
      const hay = lower(`${el.name} ${el.attrs.name ?? ""}`);
      let score = 0;
      if (lower(el.attrs.type) === "search") score += 5;
      if (/search items or categories|search items|search for/.test(hay)) score += 5;
      else if (/\bsearch\b/.test(hay)) score += 3;
      if (/\b(query|q|keyword)\b/.test(lower(el.attrs.name))) score += 2;
      if (el.role === "searchbox" || el.role === "combobox") score += 2;
      return { el, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.el.bbox[1] - b.el.bbox[1]);
  return scored[0]?.el ?? null;
}

const RUPEE_RE = /₹|\brs\.?\b|\binr\b/i;

function nameTokens(name: string): string[] {
  return lower(name)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function normalizePack(s: string): string {
  return lower(s).replace(/\s+/g, "");
}

/** Two elements sit in the SAME product tile (a tight box, so a left-rail chip never reaches the grid). */
function withinTile(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  const ca = center(a);
  const cb = center(b);
  return Math.abs(ca.x - cb.x) < 220 && Math.abs(ca.y - cb.y) < 140;
}

/**
 * Is this token-matching element a real BUYABLE tile rather than a category-rail chip? Hyperpure's
 * search results open with a left rail of category chips ("Malai Paneer", "Fresh Paneer", …) whose text
 * matches the item just as well as a product tile — clicking one navigates to a category, never adds. A
 * buyable tile always carries price/heading/ADD context: a ₹ price in its own text, a product-title
 * heading tag, or an ADD control / ₹ price physically inside the same tile. Chips have none of these.
 */
function hasBuyableContext(
  obs: Observation,
  el: SerializedElement,
  atc: readonly string[],
): boolean {
  if (RUPEE_RE.test(el.name)) return true;
  if (el.tag === "h1" || el.tag === "h2" || el.tag === "h3") return true;
  return obs.elements.some((o) => {
    if (o === el || !withinTile(o.bbox, el.bbox)) return false;
    const nm = (o.name ?? "").trim();
    return RUPEE_RE.test(nm) || (isClickable(o) && isAddLabel(nm, atc));
  });
}

/**
 * Find the product CARD/title best matching a requested item on a listing or detail page.
 *
 * Hyperpure tiles render the full SKU name (e.g. "Milky Mist - Paneer, 1 Kg") plus price/rating inside one
 * element, so we require every token of the item name to be present, then reward the brand and pack size
 * (this is what disambiguates "Milky Mist - Paneer, 1 Kg" from "Milky Mist - Spicy Paneer Sticks, 500 gm")
 * and a visible ₹ price (a real buyable tile, not a category chip).
 *
 * Category-rail chips match the item text too, so we require {@link hasBuyableContext} before a candidate
 * can win — otherwise a "Malai Paneer" category chip beats the real tile and the add silently no-ops.
 */
export function findHyperpureProductCard(
  obs: Observation,
  item: RequestedItem,
  opts: HyperpureMatchOpts = {},
): SerializedElement | null {
  const tokens = nameTokens(item.name);
  if (tokens.length === 0) return null;
  const brand = item.brand ? lower(item.brand) : "";
  const pack = item.packSize ? normalizePack(item.packSize) : "";
  const reject = cleanTokens(opts.rejectTokens);
  const atc = cleanTokens(opts.atcTokens);

  let best: SerializedElement | null = null;
  let bestScore = 0;
  for (const el of obs.elements) {
    const text = lower(el.name);
    if (!text) continue;
    // Knowledge-driven reject tokens (e.g. "sponsored") drop a tile before it can win the match.
    if (reject.length > 0 && reject.some((tok) => text.includes(tok))) continue;
    if (!tokens.every((tok) => text.includes(tok))) continue;
    // Exclude category-rail chips: only a real buyable tile (price/heading/ADD context) may win.
    if (!hasBuyableContext(obs, el, atc)) continue;

    let score = 2;
    if (brand && text.includes(brand)) score += 3;
    if (pack && normalizePack(el.name).includes(pack)) score += 3;
    if (RUPEE_RE.test(el.name)) score += 2;
    if (el.name.length > 20) score += 1; // a full tile, not a one-word chip/category
    if (el.tag === "h3" || el.tag === "h2") score += 1;

    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

// "ADD", "ADD +", "Add to cart" / "Add to basket" — the buyable controls on Hyperpure tiles & detail pages.
const ADD_LABEL_RE = /^(add(\s*\+)?|add\s+to\s+(cart|basket))$/i;

/**
 * Optional guided-RAG knowledge hints that EXTEND (never replace) the built-in Hyperpure matchers.
 * `atcTokens`/`addedTokens` are matched as EXACT button labels (Hyperpure labels are exact, e.g. "ADD +",
 * so substring-OR would wrongly match "address"); `rejectTokens` are matched as substrings of tile text.
 */
export interface HyperpureMatchOpts {
  readonly atcTokens?: readonly string[];
  readonly addedTokens?: readonly string[];
  readonly rejectTokens?: readonly string[];
}

function cleanTokens(tokens: readonly string[] | undefined): string[] {
  return (tokens ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
}

/** True when a control's label matches the base ADD regex OR is exactly one of the knowledge atc tokens. */
function isAddLabel(name: string, atcTokens: readonly string[]): boolean {
  const t = name.trim();
  if (ADD_LABEL_RE.test(t)) return true;
  if (atcTokens.length === 0) return false;
  const lc = t.toLowerCase();
  return atcTokens.includes(lc);
}

/** All buyable "ADD" controls currently on the page. */
export function findHyperpureAddButtons(
  obs: Observation,
  opts: HyperpureMatchOpts = {},
): SerializedElement[] {
  const atc = cleanTokens(opts.atcTokens);
  return obs.elements.filter((el) => isClickable(el) && isAddLabel(el.name ?? "", atc));
}

function center(b: readonly [number, number, number, number]): { x: number; y: number } {
  return { x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 };
}

function manhattan(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const ca = center(a);
  const cb = center(b);
  return Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
}

/**
 * The ADD button physically nearest a product card. Tiles place ADD inside/over the card image, so the
 * closest ADD by center distance is reliably the one for that product — this is what stops us adding a
 * neighbouring SKU (the previous blind model-chosen click).
 */
export function findAddButtonForCard(
  obs: Observation,
  card: SerializedElement,
  opts: HyperpureMatchOpts = {},
): SerializedElement | null {
  const buttons = findHyperpureAddButtons(obs, opts);
  if (buttons.length === 0) return null;
  return [...buttons].sort((p, q) => manhattan(p.bbox, card.bbox) - manhattan(q.bbox, card.bbox))[0];
}

const PLUS_RE = /^[+\u2795]$/;

// A stepper's increment/decrement controls aren't always a bare "+"/"\u2212" text node \u2014 Hyperpure also
// renders them as icon buttons whose accessible name reads "increase"/"add more" / "decrease"/"remove".
// Matching these as well is what lets `addLooksConfirmed` see the stepper that proves the add took.
const INC_RE = /^[+\u2795]$|\b(increase|increment|add more|plus)\b/i;
const DEC_RE = /^[-\u2212\u2013\u2014]$|\b(decrease|decrement|remove|minus|delete)\b/i;

/** The "+" stepper button nearest an anchor (for incrementing quantity after the first add). */
export function findPlusButtonNear(
  obs: Observation,
  anchor: SerializedElement,
): SerializedElement | null {
  const pluses = obs.elements.filter(
    (el) => isClickable(el) && PLUS_RE.test((el.name ?? "").trim()),
  );
  if (pluses.length === 0) return null;
  return [...pluses].sort(
    (p, q) => manhattan(p.bbox, anchor.bbox) - manhattan(q.bbox, anchor.bbox),
  )[0];
}

/**
 * Read the header cart-count badge, if the serializer captured it. Hyperpure's cart affordance carries a
 * small integer (e.g. "Cart 1"); we scan any cart-labelled control for a number. Returns null when the
 * badge isn't legible (so callers fall back to the stepper signal instead of trusting a phantom 0).
 */
export function readCartCount(obs: Observation): number | null {
  const cartEls: SerializedElement[] = [];
  for (const el of obs.elements) {
    const hay = lower(`${el.name} ${el.attrs.name ?? ""} ${el.attrs.href ?? ""}`);
    if (!/cart|basket/.test(hay)) continue;
    const m = (el.name ?? "").match(/\b(\d{1,3})\b/);
    if (m) return parseInt(m[1], 10);
    cartEls.push(el);
  }
  // The count often renders as a SEPARATE badge node beside the cart icon rather than inside a
  // cart-labelled element (Hyperpure: `<strong>1</strong>` is a sibling of `<img alt="Cart icon">`).
  // So when no cart-labelled element carried a digit, read the nearest bare-integer node to a cart
  // affordance — this is what makes the null→1 "item entered the cart" confirmation actually fire.
  for (const cart of cartEls) {
    let best: { n: number; d: number } | null = null;
    for (const el of obs.elements) {
      const t = (el.name ?? "").trim();
      if (!/^\d{1,3}$/.test(t)) continue;
      const d = manhattan(el.bbox, cart.bbox);
      if (d <= 140 && (best === null || d < best.d)) best = { n: parseInt(t, 10), d };
    }
    if (best) return best.n;
  }
  return null;
}

/**
 * Did adding to cart actually take effect? Hyperpure swaps a tile's ADD button for a "− qty +" stepper on
 * a successful add, so a stepper appearing near where ADD was — OR a header cart-count increase — is a
 * trustworthy confirmation. We treat the *disappearance of the ADD button at that spot* as corroborating
 * evidence too. This is what turns the old "any non-throw = added" into an honest added/failed.
 */
export function addLooksConfirmed(
  before: Observation,
  after: Observation,
  addButton: SerializedElement,
  opts: HyperpureMatchOpts = {},
): boolean {
  const beforeCount = readCartCount(before);
  const afterCount = readCartCount(after);
  if (beforeCount != null && afterCount != null && afterCount > beforeCount) return true;
  // A cart count that appears (null → number ≥ 1) after the add is just as good a signal as a rise.
  if (beforeCount == null && afterCount != null && afterCount >= 1) return true;

  const near = (el: SerializedElement): boolean => {
    const c = center(el.bbox);
    const a = center(addButton.bbox);
    return Math.abs(c.x - a.x) < 240 && Math.abs(c.y - a.y) < 160;
  };
  const trimmed = (el: SerializedElement): string => (el.name ?? "").trim();

  // Knowledge-driven confirmation: a learned "added"/"in cart" phrasing appearing near where ADD was is a
  // trustworthy signal the platform-specific stepper detection below might not have a built-in pattern for.
  const addedTokens = cleanTokens(opts.addedTokens);
  if (
    addedTokens.length > 0 &&
    after.elements.some((el) => near(el) && addedTokens.some((tok) => trimmed(el).toLowerCase().includes(tok)))
  ) {
    return true;
  }

  // The trustworthy signal: ADD swaps to a "− qty +" stepper. Accept bare +/− text OR icon buttons
  // labelled increase/decrease, near where ADD was. We deliberately do NOT treat "ADD gone + a bare
  // number appeared" as a confirmation on its own — a navigation or re-layout can leave a stray integer
  // near the old spot, which produced phantom "added" successes for items that never entered the cart.
  const hasInc = after.elements.some((el) => isClickable(el) && INC_RE.test(trimmed(el)) && near(el));
  const hasDec = after.elements.some((el) => isClickable(el) && DEC_RE.test(trimmed(el)) && near(el));
  if (hasInc && hasDec) return true;

  return false;
}

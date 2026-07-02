/**
 * Ambiguous-query detection for the product picker.
 *
 * A generic order term (e.g. "chicken") can match several DIFFERENT products on a platform — chicken
 * nugget, curry cut, whole chicken, breast — and silently auto-picking one (the wrong one) is a real
 * failure we observed live. This module decides when the sourced candidates represent materially
 * different PRODUCTS, so the UI can ask the user which they meant. Distinct pack SIZES of the SAME
 * product (paneer 1 kg vs 500 g) are deliberately NOT ambiguous — those are just value choices.
 *
 * Pure + framework-free so it's trivially unit-testable.
 */
import type { Quote } from "../domain/types";

/** A quantity/size token ("1 kg", "500 g", "750 ml", "6 pcs", "packet"…) — stripped from the product core. */
const SIZE_RE =
  /\b\d+(?:\.\d+)?\s?(?:kgs?|gms?|g|grams?|kilos?|ltrs?|litres?|liters?|l|ml|pcs?|pieces?|packets?|packs?|cartons?|dozens?|nos?)\b/gi;

/** Pack/multipack phrasing ("pack of 6", "6 x 250", "x2"). */
const PACK_RE = /\bpack of \d+\b|\b\d+\s?x\s?\d*\b|\bx\s?\d+\b/gi;

/** Non-alphanumeric noise (punctuation, separators). */
const NOISE_RE = /[^\p{L}\p{N}\s]+/gu;

/** Words that carry no product identity — dropped so they don't distort the core. */
const STOP = new Set([
  "of", "the", "with", "and", "for", "a", "an", "in", "pack", "packs", "combo",
  "fresh", "approx", "approximately", "value", "economy", "premium",
]);

/**
 * Reduce a product title to its identity "core": lowercase, strip sizes/packs/punctuation and stopwords,
 * then a sorted, de-duplicated set of the remaining significant tokens. Two titles that describe the same
 * product (differing only in size) collapse to the same core; different products get different cores.
 */
export function productCore(title: string | undefined): string {
  const cleaned = (title ?? "")
    .toLowerCase()
    .replace(PACK_RE, " ")
    .replace(SIZE_RE, " ")
    .replace(NOISE_RE, " ");
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

/**
 * True when the item's candidates span more than one distinct product (≥2 different {@link productCore}s
 * among the in-stock candidates), i.e. the user's term was ambiguous and they should pick. Falls back to
 * all candidates when none are in stock. Fewer than two candidates is never ambiguous.
 */
export function isAmbiguousItem(candidates: readonly Quote[]): boolean {
  const inStock = candidates.filter((c) => c.inStock);
  const pool = inStock.length >= 2 ? inStock : candidates;
  if (pool.length < 2) {
    return false;
  }
  const cores = new Set(pool.map((c) => productCore(c.title)).filter(Boolean));
  return cores.size >= 2;
}

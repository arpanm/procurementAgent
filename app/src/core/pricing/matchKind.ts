/**
 * Classify how well a {@link Quote} matches a {@link RequestedItem}, and choose the best candidate.
 *
 * The user's rule: auto-pick the best ₹/kg among SKUs that EXACTLY match the requested brand+size, and
 * only ask them to choose when there is NO exact match (then show nearby brand/size options). This
 * module is the pure decision layer behind that:
 *
 *  - {@link matchKind} labels a single quote "exact" (brand AND pack size both match what was asked) or
 *    "nearby" (a close substitute — different brand or size). A bare request (no brand, no size) makes
 *    any same-item SKU "exact", so we never nag the user when they didn't express a preference.
 *  - {@link chooseQuote} picks the default from a candidate list: prefer exact matches, then the lowest
 *    comparable ₹/unit among them; if none are exact, fall to the cheapest nearby. It stamps the chosen
 *    quote's {@link Quote.matchKind} so the UI knows whether to show the picker.
 *
 * Everything here is pure + framework-free (trivially unit-testable, zero cost).
 */
import type { Quote, RequestedItem } from "../domain/types";
import { comparableUnitPaise, parsePackSize, type PackSize } from "./packPricing";

/** Lowercase word tokens (length > 1) for loose brand/title containment checks. */
function tokens(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Does the quote's title contain the requested brand? True when no brand was requested. */
function brandMatches(item: RequestedItem, quote: Quote): boolean {
  if (!item.brand || item.brand.trim() === "") return true;
  const hay = quote.title.toLowerCase();
  // Every brand token must appear (so "Milky Mist" matches "Milky Mist - Paneer, 1 Kg").
  return tokens(item.brand).every((tok) => hay.includes(tok));
}

/** The pack size the user asked for, if any (from explicit packSize, else parsed from the raw text). */
function requestedPack(item: RequestedItem): PackSize | undefined {
  return parsePackSize(item.packSize) ?? parsePackSize(item.raw);
}

/** Does the quote's pack size match the requested size? True when no size was requested. */
function sizeMatches(item: RequestedItem, quote: Quote): boolean {
  const want = requestedPack(item);
  if (!want) return true; // no size preference expressed → any size is acceptable
  const have = parsePackSize(quote.packSize ?? quote.title);
  if (!have) return false; // size requested but the SKU's size is unknown → not an exact match
  return have.dimension === want.dimension && have.baseQuantity === want.baseQuantity;
}

/**
 * "exact" when the SKU matches BOTH the requested brand and pack size (each trivially satisfied when not
 * requested); otherwise "nearby" — a close substitute the user may want to swap.
 */
export function matchKind(item: RequestedItem, quote: Quote): "exact" | "nearby" {
  return brandMatches(item, quote) && sizeMatches(item, quote) ? "exact" : "nearby";
}

/** A quote with its computed match kind, ready to stamp onto the {@link Quote}. */
export interface ClassifiedQuote {
  readonly quote: Quote;
  readonly kind: "exact" | "nearby";
  readonly unitPaise: number;
}

/** Classify each candidate (kind + comparable ₹/unit) for ranking. */
export function classifyQuotes(
  item: RequestedItem,
  candidates: readonly Quote[],
): ClassifiedQuote[] {
  return candidates.map((quote) => ({
    quote: { ...quote, matchKind: matchKind(item, quote) },
    kind: matchKind(item, quote),
    unitPaise: comparableUnitPaise(quote.pricePaise, quote.packSize ?? quote.title),
  }));
}

/**
 * Choose the default quote from a candidate list. Prefers in-stock candidates, then EXACT brand+size
 * matches, then the lowest comparable ₹/unit within the chosen tier. Returns the chosen quote with its
 * {@link Quote.matchKind} stamped, or `undefined` for an empty list. When the chosen quote is "nearby"
 * the UI should offer the picker (no exact match was available).
 */
export function chooseQuote(
  item: RequestedItem,
  candidates: readonly Quote[],
): Quote | undefined {
  if (candidates.length === 0) return undefined;
  const classified = classifyQuotes(item, candidates);

  const rank = (a: ClassifiedQuote, b: ClassifiedQuote): number => {
    // In-stock first.
    const stockA = a.quote.inStock ? 0 : 1;
    const stockB = b.quote.inStock ? 0 : 1;
    if (stockA !== stockB) return stockA - stockB;
    // Exact before nearby.
    const exactA = a.kind === "exact" ? 0 : 1;
    const exactB = b.kind === "exact" ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    // Cheapest comparable ₹/unit wins.
    return a.unitPaise - b.unitPaise;
  };

  return [...classified].sort(rank)[0]?.quote;
}

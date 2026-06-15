/**
 * Pack-count reconciliation (PROCURE_COPILOT_PLAN.md §4 — "buy the RIGHT number of packs").
 *
 * The user asks for a TOTAL quantity expressed in their preferred pack size — e.g. "6 packets of
 * 500 g paneer" = 3 kg total. Each platform stocks its own pack size: Hyperpure sells 1 kg packs,
 * Amazon sells 500 g packs. Blindly carrying the requested count (6) onto every platform is wrong —
 * 6 × 1 kg = 6 kg is double what was asked. The right behaviour is to buy `ceil(totalNeeded / packSize)`
 * packs of whatever the platform actually sells:
 *   Hyperpure 1 kg packs → ceil(3 kg / 1 kg) = 3 packs
 *   Amazon    500 g packs → ceil(3 kg / 500 g) = 6 packs
 *
 * This module recomputes per-line quantities (and the rupee rollups) against the chosen platform's pack
 * size, so both the comparison UI and the staged cart use the correct count. Pure + framework-free.
 */
import type {
  Allocation,
  AllocationLine,
  PlatformAllocation,
  Quote,
  RequestedItem,
} from "../domain/types";
import { type PackSize, parsePackSize } from "./packPricing";

/** The runtime `canonicalItemId` the backend stamps on each item (the TS type omits it). */
function itemCanonicalId(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

/**
 * The TOTAL physical quantity the user asked for, reduced to a base unit (g / ml / count).
 *
 * Two cases:
 *  - Packed request ("5 packets of 1 kg paneer"): qty is a COUNT of `packSize` packs → total = qty × pack.
 *  - Loose request ("10 kg onion"): qty is ITSELF the amount in `unit` → total = parse("10 kg"). This is the
 *    case that was missing, which made "10 kg onion" buy 10 packs of a 10 kg SKU (= 100 kg) instead of 1.
 *
 * Returns `undefined` only when neither the pack size nor the qty+unit parses to a measurable dimension.
 */
function requestedTotal(item: RequestedItem): PackSize | undefined {
  const pack = parsePackSize(item.packSize);
  if (pack) {
    return { ...pack, baseQuantity: Math.max(1, item.qty) * pack.baseQuantity };
  }
  return parsePackSize(`${item.qty} ${item.unit}`);
}

/**
 * The reconciled pack count when the requested TOTAL and the SOLD pack size parse to the same dimension —
 * `ceil(totalRequested / soldPack)`. Works for both packed requests AND loose produce: "10 kg onion"
 * against a "Onion (Big), 10 Kg" SKU → 1 pack; against a "Onion (Medium), 5 Kg" SKU → 2 packs. Returns
 * `undefined` only when reconciliation truly isn't possible (unparseable sold size, dimension mismatch),
 * so callers leave the existing quantity untouched rather than guessing.
 */
export function reconciledPackCount(item: RequestedItem, quote: Quote): number | undefined {
  const requested = requestedTotal(item);
  // Prefer the explicit pack size, but fall back to the title (an empty-string packSize is not nullish,
  // so `??` alone would wrongly stop at it and never read the size out of "Onion (Big), 10 Kg").
  const sold = parsePackSize(quote.packSize) ?? parsePackSize(quote.title);
  if (
    requested &&
    sold &&
    requested.dimension === sold.dimension &&
    sold.baseQuantity > 0 &&
    requested.baseQuantity > 0
  ) {
    return Math.max(1, Math.ceil(requested.baseQuantity / sold.baseQuantity));
  }
  return undefined;
}

/**
 * How many packs of `quote`'s pack size to buy to fulfil the user's total demand for `item`. Falls back
 * to the requested count when pack sizes can't be reconciled. Convenience for display.
 */
export function packsNeeded(item: RequestedItem, quote: Quote): number {
  return reconciledPackCount(item, quote) ?? Math.max(1, item.qty);
}

/**
 * Return a copy of `allocation` with each line's quantity reconciled to the chosen platform's pack
 * size, and all rupee rollups (line totals, subtotals, platform totals, grand total, and the
 * single-platform baseline + saving) recomputed to match. Lines whose item/quote can't be matched are
 * left as-is.
 */
export function reconcileAllocation(
  allocation: Allocation,
  items: readonly RequestedItem[],
  quotes: readonly Quote[],
): Allocation {
  const itemById = new Map(items.map((i) => [itemCanonicalId(i), i] as const));

  const findQuote = (platform: Quote["platform"], canonicalItemId: string, skuId: string): Quote | undefined =>
    quotes.find((q) => q.platform === platform && q.skuId === skuId) ??
    quotes.find((q) => q.platform === platform && q.canonicalItemId === canonicalItemId);

  let changed = false;
  const reconcileLine = (line: AllocationLine, platform: Quote["platform"]): AllocationLine => {
    const item = itemById.get(line.canonicalItemId);
    const quote = findQuote(platform, line.canonicalItemId, line.skuId);
    if (!item || !quote) return line;
    const qty = reconciledPackCount(item, quote);
    // Only adjust when we can genuinely reconcile pack sizes; otherwise leave the optimizer's line
    // exactly as-is (loose produce, unparseable sizes — guessing here would corrupt valid quantities).
    if (qty === undefined || qty === line.qty) return line;
    changed = true;
    return { ...line, qty, lineTotalPaise: qty * line.unitPricePaise };
  };

  const perPlatform: PlatformAllocation[] = allocation.perPlatform.map((p) => {
    const lines = p.lines.map((l) => reconcileLine(l, p.platform));
    const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
    return {
      ...p,
      lines,
      subtotalPaise,
      totalPaise: subtotalPaise + p.deliveryFeePaise,
    };
  });

  // Nothing was reconcilable → return the backend allocation untouched (preserves its baseline/saving).
  if (!changed) return allocation;

  const grandTotalPaise = perPlatform.reduce((s, p) => s + p.totalPaise, 0);
  const singlePlatformBaselinePaise =
    singlePlatformBaseline(items, quotes) ?? allocation.singlePlatformBaselinePaise;

  return {
    ...allocation,
    perPlatform,
    grandTotalPaise,
    singlePlatformBaselinePaise,
    savingPaise: grandTotalPaise - singlePlatformBaselinePaise,
  };
}

/**
 * Cheapest cost to fulfil the WHOLE basket on a single platform, using reconciled pack counts. Returns
 * `undefined` when no single platform can supply every requested item (so the caller keeps the backend
 * baseline). Used for the "you save vs one platform" comparison.
 */
function singlePlatformBaseline(
  items: readonly RequestedItem[],
  quotes: readonly Quote[],
): number | undefined {
  const platforms = [...new Set(quotes.map((q) => q.platform))];
  let best: number | undefined;
  for (const platform of platforms) {
    let total = 0;
    let canFulfilAll = true;
    for (const item of items) {
      const id = itemCanonicalId(item);
      const quote =
        quotes.find((q) => q.platform === platform && q.canonicalItemId === id && q.inStock) ??
        quotes.find((q) => q.platform === platform && q.canonicalItemId === id);
      if (!quote) {
        canFulfilAll = false;
        break;
      }
      total += packsNeeded(item, quote) * quote.pricePaise;
    }
    if (canFulfilAll && (best === undefined || total < best)) {
      best = total;
    }
  }
  return best;
}

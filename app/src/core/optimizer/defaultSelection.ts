/**
 * Default per-item platform pick, by best value (₹ per kg / L / piece).
 *
 * The backend optimizer ranks by raw pack price, which unfairly favours smaller packs (a 500 g pack
 * "looks" cheaper than a 1 kg pack even when it costs more per kg). Before the first optimize we seed
 * a pin per item to the platform with the lowest *per-unit* price, so the default the user sees is the
 * genuinely best-value option. The user can still switch per item in the comparison UI.
 */
import type { PlatformId, Quote } from "../domain/types";
import { comparableUnitPaise } from "../pricing/packPricing";

/**
 * For each canonical item, choose the in-stock quote with the lowest comparable per-unit price.
 * Returns a `{ canonicalItemId → platform }` map suitable for the optimizer's `pins`. Items with only
 * out-of-stock quotes are pinned to their cheapest-per-unit quote anyway (so the optimizer still has a
 * target); items with no quotes are omitted.
 */
export function defaultPlatformPins(
  quotes: readonly Quote[],
): Record<string, PlatformId> {
  const best = new Map<string, { platform: PlatformId; unit: number; inStock: boolean }>();
  for (const quote of quotes) {
    const unit = comparableUnitPaise(quote.pricePaise, quote.packSize ?? quote.title);
    const current = best.get(quote.canonicalItemId);
    if (!current) {
      best.set(quote.canonicalItemId, { platform: quote.platform, unit, inStock: quote.inStock });
      continue;
    }
    // Prefer in-stock over out-of-stock; among the same stock status, prefer the lower per-unit price.
    const better =
      (quote.inStock && !current.inStock) ||
      (quote.inStock === current.inStock && unit < current.unit);
    if (better) {
      best.set(quote.canonicalItemId, { platform: quote.platform, unit, inStock: quote.inStock });
    }
  }
  const pins: Record<string, PlatformId> = {};
  for (const [canonicalItemId, pick] of best) {
    pins[canonicalItemId] = pick.platform;
  }
  return pins;
}

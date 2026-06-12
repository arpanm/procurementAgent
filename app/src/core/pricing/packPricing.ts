/**
 * Pack-size parsing + per-unit price normalisation (used by the comparison UI and the default
 * platform pick).
 *
 * Platforms list the same item in different pack sizes — Hyperpure "Milky Mist Paneer, 1 Kg" vs
 * Amazon "Milky Mist Paneer, 500 g" — so comparing the raw pack price is misleading (the smaller pack
 * always looks "cheaper"). We parse the pack size out of the product title and reduce every quote to a
 * comparable **price per base unit** (₹/kg, ₹/L, or ₹/piece) so the user (and the default selection)
 * can judge true value across sizes. Everything here is pure + framework-free so it is trivially
 * unit-testable and runs with zero cost.
 */

/** The physical dimension a pack size is measured in. */
export type PackDimension = "weight" | "volume" | "count";

/** A parsed pack size reduced to a base quantity (grams for weight, ml for volume, count for pieces). */
export interface PackSize {
  /** The original matched text, e.g. "1 Kg", "500 g", "6 x 100 g". */
  readonly raw: string;
  readonly dimension: PackDimension;
  /** Quantity in the base unit: grams (weight), millilitres (volume), or count (pieces). */
  readonly baseQuantity: number;
}

/** A price reduced to one comparable display unit. */
export interface PerUnitPrice {
  /** Price in paise per `unitLabel`. */
  readonly pricePaise: number;
  /** The display unit the price is per: "kg", "L", or "piece". */
  readonly unitLabel: "kg" | "L" | "piece";
}

interface UnitDef {
  readonly dimension: PackDimension;
  /** Multiplier to convert this unit into the base unit (g / ml / count). */
  readonly toBase: number;
}

// Order matters only for the alternation below (longer tokens first so "kg" wins over "g").
const UNITS: ReadonlyArray<readonly [RegExp, UnitDef]> = [
  [/^(?:kgs?|kilograms?|kilos?)$/i, { dimension: "weight", toBase: 1000 }],
  [/^(?:gms?|grams?|g)$/i, { dimension: "weight", toBase: 1 }],
  [/^(?:litres?|liters?|ltrs?|l)$/i, { dimension: "volume", toBase: 1000 }],
  [/^(?:ml|millilitres?|milliliters?)$/i, { dimension: "volume", toBase: 1 }],
  [/^(?:pcs?|pieces?|pkts?|packets?|units?|nos?)$/i, { dimension: "count", toBase: 1 }],
  [/^(?:dozen|dozens)$/i, { dimension: "count", toBase: 12 }],
];

function unitFor(token: string): UnitDef | undefined {
  for (const [re, def] of UNITS) {
    if (re.test(token)) return def;
  }
  return undefined;
}

// A number immediately followed by a unit token, e.g. "500 g", "1Kg", "1.5 l", "250ml".
const QTY_UNIT_RE =
  /(\d+(?:\.\d+)?)\s*(kgs?|kilograms?|kilos?|gms?|grams?|g|litres?|liters?|ltrs?|ml|millilitres?|milliliters?|l|pcs?|pieces?|pkts?|packets?|units?|nos?|dozens?)\b/i;

// A multipack: "6 x 100 g", "12 × 200ml", "pack of 6". The leading count multiplies the per-pack size.
const MULTIPACK_RE =
  /(\d+)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)\s*(kgs?|kilograms?|kilos?|gms?|grams?|g|litres?|liters?|ltrs?|ml|millilitres?|milliliters?|l|pcs?|pieces?|units?)\b/i;
const PACK_OF_RE = /pack\s+of\s+(\d+)/i;

/**
 * Parse the first pack size out of a free-text product title (or an explicit pack-size string).
 * Returns `undefined` when no size token is present (e.g. a loose-produce title), so callers can fall
 * back to the raw pack price.
 */
export function parsePackSize(text: string | null | undefined): PackSize | undefined {
  if (!text || typeof text !== "string") return undefined;

  const multi = MULTIPACK_RE.exec(text);
  if (multi) {
    const count = Number(multi[1]);
    const each = Number(multi[2]);
    const def = unitFor(multi[3]);
    if (def && count > 0 && each > 0) {
      return { raw: multi[0].trim(), dimension: def.dimension, baseQuantity: count * each * def.toBase };
    }
  }

  const single = QTY_UNIT_RE.exec(text);
  if (single) {
    const value = Number(single[1]);
    const def = unitFor(single[2]);
    if (def && value > 0) {
      return { raw: single[0].trim(), dimension: def.dimension, baseQuantity: value * def.toBase };
    }
  }

  const packOf = PACK_OF_RE.exec(text);
  if (packOf) {
    const count = Number(packOf[1]);
    if (count > 0) {
      return { raw: packOf[0].trim(), dimension: "count", baseQuantity: count };
    }
  }

  return undefined;
}

/**
 * Reduce a pack price to a comparable per-unit price (₹/kg, ₹/L, or ₹/piece). Returns `undefined`
 * when the pack size can't be parsed, so the UI falls back to showing the raw pack price.
 */
export function perUnitPrice(
  pricePaise: number,
  pack: PackSize | undefined,
): PerUnitPrice | undefined {
  if (!pack || pack.baseQuantity <= 0 || !Number.isFinite(pricePaise)) return undefined;
  switch (pack.dimension) {
    case "weight":
      // baseQuantity is grams → price per kg.
      return { pricePaise: Math.round(pricePaise / (pack.baseQuantity / 1000)), unitLabel: "kg" };
    case "volume":
      // baseQuantity is ml → price per litre.
      return { pricePaise: Math.round(pricePaise / (pack.baseQuantity / 1000)), unitLabel: "L" };
    case "count":
      return { pricePaise: Math.round(pricePaise / pack.baseQuantity), unitLabel: "piece" };
  }
}

/**
 * A single comparable number for ranking quotes of an item: the per-unit price when the pack size is
 * known, otherwise the raw pack price. Lower is better. Used to pick the default platform per item.
 */
export function comparableUnitPaise(pricePaise: number, title: string | undefined): number {
  const per = perUnitPrice(pricePaise, parsePackSize(title));
  return per ? per.pricePaise : pricePaise;
}

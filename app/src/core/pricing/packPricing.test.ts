import { describe, expect, it } from "vitest";
import {
  comparableUnitPaise,
  parsePackSize,
  perUnitPrice,
} from "./packPricing";

describe("parsePackSize", () => {
  it("parses kilograms from a product title", () => {
    expect(parsePackSize("Milky Mist - Paneer, 1 Kg")).toEqual({
      raw: "1 Kg",
      dimension: "weight",
      baseQuantity: 1000,
    });
  });

  it("parses grams with no space", () => {
    expect(parsePackSize("Amul Paneer 500g block")).toEqual({
      raw: "500g",
      dimension: "weight",
      baseQuantity: 500,
    });
  });

  it("parses litres and millilitres", () => {
    expect(parsePackSize("Amul Gold Milk 1 L")?.baseQuantity).toBe(1000);
    expect(parsePackSize("Coca Cola 750 ml")?.baseQuantity).toBe(750);
  });

  it("parses a multipack as the total quantity", () => {
    expect(parsePackSize("Maaza Mango 6 x 200 ml")).toEqual({
      raw: "6 x 200 ml",
      dimension: "volume",
      baseQuantity: 1200,
    });
  });

  it("parses 'pack of N' as a count", () => {
    expect(parsePackSize("Surf Excel Pack of 6")).toEqual({
      raw: "Pack of 6",
      dimension: "count",
      baseQuantity: 6,
    });
  });

  it("returns undefined when there is no size token", () => {
    expect(parsePackSize("Fresh Paneer")).toBeUndefined();
    expect(parsePackSize("")).toBeUndefined();
    expect(parsePackSize(null)).toBeUndefined();
  });
});

describe("perUnitPrice", () => {
  it("computes ₹/kg so a 1kg pack and a 500g pack are comparable", () => {
    // 1 Kg @ ₹399 → ₹399/kg
    expect(perUnitPrice(39900, parsePackSize("Paneer 1 Kg"))).toEqual({
      pricePaise: 39900,
      unitLabel: "kg",
    });
    // 500 g @ ₹99 → ₹198/kg (cheaper per kg)
    expect(perUnitPrice(9900, parsePackSize("Paneer 500 g"))).toEqual({
      pricePaise: 19800,
      unitLabel: "kg",
    });
  });

  it("computes ₹/L for volume", () => {
    expect(perUnitPrice(6000, parsePackSize("Oil 750 ml"))).toEqual({
      pricePaise: 8000,
      unitLabel: "L",
    });
  });

  it("computes ₹/piece for a count pack", () => {
    expect(perUnitPrice(12000, parsePackSize("Eggs pack of 6"))).toEqual({
      pricePaise: 2000,
      unitLabel: "piece",
    });
  });

  it("returns undefined when pack size is unknown", () => {
    expect(perUnitPrice(9900, undefined)).toBeUndefined();
  });
});

describe("comparableUnitPaise", () => {
  it("ranks a cheaper-per-kg larger pack below a smaller pack", () => {
    const big = comparableUnitPaise(39900, "Paneer 1 Kg"); // 39900/kg
    const small = comparableUnitPaise(9900, "Paneer 500 g"); // 19800/kg
    expect(small).toBeLessThan(big);
  });

  it("falls back to the raw pack price when size is unknown", () => {
    expect(comparableUnitPaise(9900, "Fresh Paneer")).toBe(9900);
  });
});

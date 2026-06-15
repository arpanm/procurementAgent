import { describe, expect, it } from "vitest";
import type { Observation } from "../../automation/AutomationEngine";
import { parsePackSize } from "../../pricing/packPricing";
import { extractAmazonDetail } from "./detailExtract";
import { AMZ_DETAIL_OOS, AMZ_DETAIL_PANEER } from "./detailFixtures";

describe("extractAmazonDetail", () => {
  it("reads the true buybox price, MRP, stock and pack size off the paneer detail page", () => {
    const detail = extractAmazonDetail(AMZ_DETAIL_PANEER);

    expect(detail.title).toContain("Milky Mist Paneer");
    expect(detail.pricePaise).toBe(23700); // ₹237.00, the buybox selling price — NOT the ₹260 MRP.
    expect(detail.mrpPaise).toBe(26000); // ₹260.00 struck-through M.R.P.
    expect(detail.inStock).toBe(true);
    // packSize mirrors whatever parsePackSize derives from the title ("500 g").
    expect(detail.packSize).toBe(parsePackSize(AMZ_DETAIL_PANEER.title)?.raw ?? "500 g");
    expect(detail.packSize).toBe("500 g");
  });

  it("does NOT pick the sponsored-carousel ₹99 (guards the ₹99-instead-of-₹237 bug)", () => {
    const detail = extractAmazonDetail(AMZ_DETAIL_PANEER);
    // The page carries off-buybox prices: a sponsored Amul tile at ₹99 and a Gowardhan tile at ₹420.
    // The extractor must anchor on the buybox and ignore both.
    expect(detail.pricePaise).not.toBe(9900);
    expect(detail.pricePaise).not.toBe(42000);
    expect(detail.pricePaise).toBe(23700);
  });

  it("never returns the struck MRP as the selling price", () => {
    const detail = extractAmazonDetail(AMZ_DETAIL_PANEER);
    expect(detail.pricePaise).not.toBe(detail.mrpPaise);
    expect(detail.pricePaise! < detail.mrpPaise!).toBe(true);
  });

  it("reports out of stock when the buybox shows 'Currently unavailable' and has no Add-to-Cart", () => {
    const detail = extractAmazonDetail(AMZ_DETAIL_OOS);
    expect(detail.inStock).toBe(false);
    expect(detail.title).toContain("Milky Mist Paneer");
  });

  it("returns inStock false for an empty page (no affordance, no stock copy)", () => {
    const empty: Observation = {
      url: "https://www.amazon.in/dp/B018E0LQ8W",
      title: "Amazon.in",
      scroll: { y: 0, h: 0, vh: 720 },
      elements: [],
    };
    const detail = extractAmazonDetail(empty);
    expect(detail.inStock).toBe(false);
    expect(detail.pricePaise).toBeUndefined();
    expect(detail.title).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { Observation } from "../../automation/AutomationEngine";
import type { RequestedItem } from "../../domain/types";
import { serializeDom } from "../../automation/injected/domSerializer";
import { AMZ_SEARCH_RESULTS, mountFixture } from "../../adapters/recordedFixtures";
import {
  amazonProductUrl,
  asinFromUrl,
  findAmazonResultCard,
  isAmazonDetailUrl,
  isAmazonProductHref,
} from "./selectors";

// The recorded fixture is static HTML; mount it into jsdom and run the real perceiver to get the
// same `Observation` shape the live engine hands the selectors.
function observe(html: string): Observation {
  mountFixture(html);
  return serializeDom(document, window);
}

const onion: RequestedItem = { raw: "10kg onion", name: "onion", qty: 10, unit: "kg" };
const paneer: RequestedItem = { raw: "1kg paneer", name: "paneer", qty: 1, unit: "kg" };
const oil: RequestedItem = { raw: "1 carton refined oil", name: "refined oil", qty: 1, unit: "carton" };

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("findAmazonResultCard (recorded AMZ_SEARCH_RESULTS fixture)", () => {
  it("picks the real product link (a /dp/ tile, not a filter/cart chrome link) for onion", () => {
    const obs = observe(AMZ_SEARCH_RESULTS);

    const card = findAmazonResultCard(obs, onion);
    expect(card).not.toBeNull();
    // It is an anchor pointing at a product detail page, not a "Cart (0)"/filter nav link.
    expect(card!.tag).toBe("a");
    expect(card!.name).toContain("Fresh Onion");
    expect(card!.name).not.toMatch(/cart/i);
    // Its href is a real product-detail href (and a real ASIN parses out of it once absolutised).
    expect(card!.attrs.href).toBe("/dp/B0ONION10");
    expect(isAmazonProductHref(card!.attrs.href)).toBe(true);
    expect(isAmazonDetailUrl(card!.attrs.href)).toBe(true);
    // A genuine 10-char ASIN on the same /dp/ shape parses out via asinFromUrl.
    expect(asinFromUrl("https://www.amazon.in/Onion/dp/B0ONION100/ref=sr_1_1")).toBe("B0ONION100");
  });

  it("matches paneer and refined oil to their own product tiles", () => {
    const obs = observe(AMZ_SEARCH_RESULTS);

    const paneerCard = findAmazonResultCard(obs, paneer);
    expect(paneerCard).not.toBeNull();
    expect(paneerCard!.name).toContain("Paneer");
    expect(paneerCard!.attrs.href).toBe("/dp/B0PANEER1");
    expect(isAmazonProductHref(paneerCard!.attrs.href)).toBe(true);

    const oilCard = findAmazonResultCard(obs, oil);
    expect(oilCard).not.toBeNull();
    expect(oilCard!.name).toContain("Refined Sunflower Oil");
    expect(oilCard!.attrs.href).toBe("/dp/B0OIL5L");
    expect(isAmazonProductHref(oilCard!.attrs.href)).toBe(true);
  });

  it("resolves the matched card to a clean absolute /dp/<ASIN> product URL", () => {
    const obs = observe(AMZ_SEARCH_RESULTS);
    const card = findAmazonResultCard(obs, onion)!;

    const url = amazonProductUrl(card, "https://www.amazon.in/s?k=onion");
    expect(url).toBe("https://www.amazon.in/dp/B0ONION10");
    expect(isAmazonDetailUrl(url)).toBe(true);
  });

  it("returns null when no card matches the requested item", () => {
    const obs = observe(AMZ_SEARCH_RESULTS);
    const nonsense: RequestedItem = { raw: "1 widget", name: "quantum widget", qty: 1, unit: "piece" };
    expect(findAmazonResultCard(obs, nonsense)).toBeNull();
  });
});

describe("asinFromUrl", () => {
  it("extracts the ASIN from a /dp/<ASIN>/ref=… product URL", () => {
    expect(
      asinFromUrl("https://www.amazon.in/Milky-Mist-Paneer/dp/B018E0LQ8W/ref=sr_1_3?keywords=paneer"),
    ).toBe("B018E0LQ8W");
  });

  it("extracts the ASIN from /gp/product/ and /dp/product/ forms", () => {
    expect(asinFromUrl("https://www.amazon.in/gp/product/B018E0LQ8W")).toBe("B018E0LQ8W");
    expect(asinFromUrl("https://www.amazon.in/dp/product/B07XYZ1234?th=1")).toBe("B07XYZ1234");
  });

  it("extracts the ASIN from an explicit ?ASIN= query parameter", () => {
    expect(asinFromUrl("https://www.amazon.in/gp/aws/cart/add.html?ASIN.1=B018E0LQ8W")).toBe(
      "B018E0LQ8W",
    );
  });

  it("returns null for non-product / null / empty urls", () => {
    expect(asinFromUrl("https://www.amazon.in/s?k=onion&rh=p_36")).toBeNull();
    expect(asinFromUrl(null)).toBeNull();
    expect(asinFromUrl(undefined)).toBeNull();
    expect(asinFromUrl("")).toBeNull();
  });
});

describe("isAmazonDetailUrl", () => {
  it("is true for /dp/ and /gp/product/ detail pages", () => {
    expect(isAmazonDetailUrl("https://www.amazon.in/Milky-Mist/dp/B018E0LQ8W")).toBe(true);
    expect(isAmazonDetailUrl("https://www.amazon.in/gp/product/B0ONION10")).toBe(true);
  });

  it("is false for search/filter pages and nullish input", () => {
    expect(isAmazonDetailUrl("https://www.amazon.in/s?k=paneer")).toBe(false);
    expect(isAmazonDetailUrl(null)).toBe(false);
    expect(isAmazonDetailUrl(undefined)).toBe(false);
  });
});

describe("isAmazonProductHref", () => {
  it("is true for product-detail hrefs", () => {
    expect(isAmazonProductHref("/dp/B018E0LQ8W/ref=sr_1_3")).toBe(true);
    expect(isAmazonProductHref("/gp/product/B0ONION10")).toBe(true);
  });

  it("is false for search/refinement/auth chrome", () => {
    expect(isAmazonProductHref("/s?k=onion&rh=p_36%3A1318474031")).toBe(false);
    expect(isAmazonProductHref("/ap/signin")).toBe(false);
    expect(isAmazonProductHref("/gp/cart")).toBe(false);
    expect(isAmazonProductHref(null)).toBe(false);
  });
});

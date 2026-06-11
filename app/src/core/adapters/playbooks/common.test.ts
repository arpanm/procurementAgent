import { describe, expect, it } from "vitest";
import type { RequestedItem } from "../../domain/types";
import { searchQueryFor } from "./common";

function item(over: Partial<RequestedItem>): RequestedItem {
  return { raw: "x", name: "paneer", qty: 1, unit: "packet", ...over };
}

describe("searchQueryFor", () => {
  it("joins brand + variant + name + pack size for a specific match", () => {
    expect(
      searchQueryFor(item({ name: "rice", brand: "India Gate", variant: "basmati", packSize: "1 kg" })),
    ).toBe("India Gate basmati rice 1 kg");
  });

  it("de-dupes a brand that the parser also baked into the name", () => {
    // The parser commonly returns name="milky mist paneer" AND brand="Milky Mist"; the query must not
    // become the over-stuffed "milky mist milky mist paneer 500 g".
    expect(
      searchQueryFor(item({ name: "milky mist paneer", brand: "Milky Mist", packSize: "500 g" })),
    ).toBe("Milky Mist paneer 500 g");
  });

  it("falls back to the plain name with no refinements", () => {
    expect(searchQueryFor(item({ name: "paneer" }))).toBe("paneer");
  });

  it("returns an empty string for a missing item", () => {
    expect(searchQueryFor(undefined)).toBe("");
  });
});

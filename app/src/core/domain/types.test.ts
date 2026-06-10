import { describe, expect, it } from "vitest";
import { formatRupees, SUPPORTED_PLATFORMS } from "./types";

describe("domain types", () => {
  it("supports exactly the MVP platforms", () => {
    expect([...SUPPORTED_PLATFORMS]).toEqual(["hyperpure", "amazon"]);
  });

  it("formats paise as Indian-grouped rupees", () => {
    expect(formatRupees(0)).toBe("₹0");
    expect(formatRupees(3800)).toBe("₹38");
    expect(formatRupees(2150050)).toBe("₹21,500.5");
  });
});

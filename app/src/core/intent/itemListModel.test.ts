import { describe, expect, it } from "vitest";
import type { RequestedItem } from "../domain/types";
import {
  addItem,
  editQty,
  editTextField,
  editUnit,
  removeItem,
  SELECTABLE_UNITS,
  summarize,
} from "./itemListModel";

const base: readonly RequestedItem[] = [
  { raw: "5 kilo aloo", name: "potato", qty: 5, unit: "kg" },
  { raw: "2 carton tel", name: "refined oil", qty: 2, unit: "carton", notes: "refined" },
];

describe("itemListModel", () => {
  it("editQty returns a new array without mutating the input", () => {
    const next = editQty(base, 0, 8);
    expect(next).not.toBe(base);
    expect(next[0]).not.toBe(base[0]);
    expect(next[0].qty).toBe(8);
    expect(base[0].qty).toBe(5);
    expect(next[1]).toBe(base[1]);
  });

  it("editQty clamps non-positive / non-finite quantities to 0", () => {
    expect(editQty(base, 0, -3)[0].qty).toBe(0);
    expect(editQty(base, 0, Number.NaN)[0].qty).toBe(0);
  });

  it("editQty is a no-op for out-of-range indices", () => {
    expect(editQty(base, 9, 4)).toBe(base);
    expect(editQty(base, -1, 4)).toBe(base);
  });

  it("editUnit returns a new array with the unit changed", () => {
    const next = editUnit(base, 1, "l");
    expect(next).not.toBe(base);
    expect(next[1].unit).toBe("l");
    expect(base[1].unit).toBe("carton");
  });

  it("removeItem returns a new array without the item", () => {
    const next = removeItem(base, 0);
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(base[1]);
    expect(base).toHaveLength(2);
  });

  it("addItem appends without mutating the input", () => {
    const item: RequestedItem = { raw: "1 dozen anda", name: "egg", qty: 1, unit: "dozen" };
    const next = addItem(base, item);
    expect(next).toHaveLength(3);
    expect(next[2]).toBe(item);
    expect(base).toHaveLength(2);
  });

  it("summarize produces a plain-language line per item, including notes", () => {
    expect(summarize(base)).toBe("5 kg potato\n2 carton refined oil (refined)");
    expect(summarize([])).toBe("");
  });

  it("summarize includes brand, variant and pack size when present", () => {
    const items: readonly RequestedItem[] = [
      {
        raw: "1kg india gate basmati rice 5 packets",
        name: "rice",
        qty: 5,
        unit: "packet",
        brand: "India Gate",
        variant: "basmati",
        packSize: "1 kg",
      },
    ];
    expect(summarize(items)).toBe("5 packet India Gate basmati rice (1 kg)");
  });

  it("editTextField sets a refinement field and clears it on empty input", () => {
    const set = editTextField(base, 0, "brand", "Aashirvaad");
    expect(set).not.toBe(base);
    expect(set[0].brand).toBe("Aashirvaad");
    expect(base[0].brand).toBeUndefined();

    const cleared = editTextField(set, 0, "brand", "   ");
    expect(cleared[0].brand).toBeUndefined();
  });

  it("editTextField keeps name as a string and no-ops out-of-range indices", () => {
    expect(editTextField(base, 0, "name", "")[0].name).toBe("");
    expect(editTextField(base, 9, "variant", "x")).toBe(base);
  });

  it("exposes all domain units as selectable", () => {
    expect([...SELECTABLE_UNITS]).toEqual([
      "kg",
      "g",
      "l",
      "ml",
      "piece",
      "packet",
      "carton",
      "dozen",
    ]);
  });
});

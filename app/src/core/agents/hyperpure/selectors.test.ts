import { describe, expect, it } from "vitest";
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import type { RequestedItem } from "../../domain/types";
import {
  addLooksConfirmed,
  findAddButtonForCard,
  findHyperpureProductCard,
  findHyperpureSearchInput,
  findPlusButtonNear,
  isHyperpureProductUrl,
  isHyperpureSearchUrl,
  readCartCount,
} from "./selectors";

function el(partial: Partial<SerializedElement> & { idx: number }): SerializedElement {
  return {
    idx: partial.idx,
    tag: partial.tag ?? "div",
    role: partial.role ?? null,
    name: partial.name ?? "",
    value: partial.value ?? null,
    bbox: partial.bbox ?? [0, 0, 0, 0],
    attrs: partial.attrs ?? {},
  };
}

function obs(elements: SerializedElement[], url = "https://www.hyperpure.com/"): Observation {
  return { url, title: "", scroll: { y: 0, h: 0, vh: 0 }, elements };
}

const onion: RequestedItem = { raw: "10 kg onion", name: "onion", qty: 10, unit: "kg" };
const paneer: RequestedItem = {
  raw: "5 milky mist paneer 1 kg",
  name: "paneer",
  qty: 5,
  unit: "packet",
  brand: "Milky Mist",
  packSize: "1 kg",
};

describe("hyperpure url helpers", () => {
  it("recognizes search vs product vs other routes", () => {
    expect(isHyperpureSearchUrl("https://www.hyperpure.com/in/search/onion?type=SEARCH")).toBe(true);
    expect(isHyperpureSearchUrl("https://www.hyperpure.com/")).toBe(false);

    expect(isHyperpureProductUrl("https://www.hyperpure.com/in/milky-mist-paneer-1-kg?source=SEARCH_ALL")).toBe(
      true,
    );
    expect(isHyperpureProductUrl("https://www.hyperpure.com/in/search/paneer")).toBe(false);
    expect(isHyperpureProductUrl("https://www.hyperpure.com/in/cart")).toBe(false);
    expect(isHyperpureProductUrl("https://www.hyperpure.com/")).toBe(false);
  });
});

describe("findHyperpureSearchInput", () => {
  it("picks the search box by placeholder over an unrelated input", () => {
    const page = obs([
      el({ idx: 7, tag: "input", name: "Select location", attrs: { type: "text", name: "location" }, bbox: [10, 20, 100, 30] }),
      el({
        idx: 8,
        tag: "input",
        role: "combobox",
        name: "Search items or categories",
        attrs: { type: "text", name: "query" },
        bbox: [120, 18, 300, 30],
      }),
    ]);
    expect(findHyperpureSearchInput(page)?.idx).toBe(8);
  });

  it("matches an explicit type=search input", () => {
    const page = obs([el({ idx: 3, tag: "input", name: "", attrs: { type: "search" } })]);
    expect(findHyperpureSearchInput(page)?.idx).toBe(3);
  });

  it("returns null when there is no search affordance", () => {
    const page = obs([el({ idx: 1, tag: "input", name: "Email", attrs: { type: "email" } })]);
    expect(findHyperpureSearchInput(page)).toBeNull();
  });
});

describe("findHyperpureProductCard", () => {
  // Mirrors the real onion search results (screenshot/URL): several onion SKUs of different pack sizes.
  const onionResults = obs(
    [
      el({ idx: 10, tag: "h3", name: "Onion (Big), 10 Kg 10 kg | 4.4 (459) ₹364 ₹36.4/kg", bbox: [20, 200, 200, 60] }),
      el({ idx: 11, tag: "h3", name: "Onion (Medium), 5 Kg 5 kg | 4.6 (559) ₹142 ₹28.4/kg", bbox: [260, 200, 200, 60] }),
      el({ idx: 12, tag: "h3", name: "Spring Onion, 250 gm 0.25 kg | 4.5 (669) ₹29", bbox: [260, 600, 200, 60] }),
    ],
    "https://www.hyperpure.com/in/search/onion",
  );

  it("finds an onion tile (the search that used to fail entirely)", () => {
    const card = findHyperpureProductCard(onionResults, onion);
    expect(card).not.toBeNull();
    expect(card?.name).toContain("Onion");
  });

  // Mirrors the paneer results: brand + pack size must disambiguate Paneer 1 Kg from Spicy Paneer Sticks.
  const paneerResults = obs(
    [
      el({ idx: 20, tag: "h3", name: "Hyperpure - Spicy Paneer Sticks, 500 gm (Frozen) 0.50 kg | 4.3 (18) ₹250", bbox: [20, 200, 200, 60] }),
      el({ idx: 21, tag: "h3", name: "Milky Mist - Paneer, 1 Kg 1 kg | 5 (737) ₹354 ₹354/kg", bbox: [260, 200, 200, 60] }),
      el({ idx: 22, tag: "h3", name: "Modern Dairy - Malai Paneer, 1 Kg 1 kg | 4.8 (194) ₹332", bbox: [20, 600, 200, 60] }),
    ],
    "https://www.hyperpure.com/in/search/paneer",
  );

  it("disambiguates by brand + pack size to the Milky Mist 1 Kg tile", () => {
    const card = findHyperpureProductCard(paneerResults, paneer);
    expect(card?.idx).toBe(21);
  });
});

describe("findAddButtonForCard / findPlusButtonNear", () => {
  const card = el({ idx: 21, tag: "h3", name: "Milky Mist - Paneer, 1 Kg ₹354", bbox: [260, 200, 200, 60] });
  const page = obs([
    card,
    el({ idx: 30, tag: "button", name: "ADD", bbox: [40, 230, 90, 40] }), // far card's ADD
    el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] }), // this card's ADD
  ]);

  it("picks the ADD button nearest the target card", () => {
    expect(findAddButtonForCard(page, card)?.idx).toBe(31);
  });

  it("finds the nearest + stepper for quantity increment", () => {
    const stepperPage = obs([
      card,
      el({ idx: 40, tag: "button", name: "−", bbox: [290, 240, 30, 30] }),
      el({ idx: 41, tag: "button", name: "+", bbox: [380, 240, 30, 30] }),
    ]);
    expect(findPlusButtonNear(stepperPage, card)?.idx).toBe(41);
  });
});

describe("readCartCount + addLooksConfirmed", () => {
  it("reads a numeric cart badge", () => {
    const page = obs([el({ idx: 1, tag: "a", name: "Cart 2", attrs: { href: "/in/cart" } })]);
    expect(readCartCount(page)).toBe(2);
  });

  it("confirms an add when a − qty + stepper replaces ADD at the same spot", () => {
    const addButton = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });
    const before = obs([addButton]);
    const after = obs([
      el({ idx: 40, tag: "button", name: "−", bbox: [290, 240, 30, 30] }),
      el({ idx: 41, tag: "button", name: "1", bbox: [330, 240, 30, 30] }),
      el({ idx: 42, tag: "button", name: "+", bbox: [380, 240, 30, 30] }),
    ]);
    expect(addLooksConfirmed(before, after, addButton)).toBe(true);
  });

  it("confirms an add when the cart count increases", () => {
    const addButton = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });
    const before = obs([addButton, el({ idx: 1, tag: "a", name: "Cart 0", attrs: { href: "/in/cart" } })]);
    const after = obs([addButton, el({ idx: 1, tag: "a", name: "Cart 1", attrs: { href: "/in/cart" } })]);
    expect(addLooksConfirmed(before, after, addButton)).toBe(true);
  });

  it("returns false when nothing changed (the silent-failure case)", () => {
    const addButton = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });
    const page = obs([addButton]);
    expect(addLooksConfirmed(page, page, addButton)).toBe(false);
  });
});

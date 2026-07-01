import { describe, expect, it } from "vitest";
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import type { RequestedItem } from "../../domain/types";
import {
  addLooksConfirmed,
  findAddButtonForCard,
  findHyperpureAddButtons,
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

  it("reads the count from a badge node sitting beside the cart icon", () => {
    // Hyperpure's real header: the count `<strong>1</strong>` is a SIBLING of `<img alt="Cart icon">`,
    // so the digit isn't inside a cart-labelled element. The reader must pick up the adjacent badge.
    const page = obs([
      el({ idx: 5, tag: "img", name: "Cart icon", bbox: [900, 10, 30, 30] }),
      el({ idx: 6, tag: "strong", name: "1", bbox: [918, 8, 14, 14] }),
    ]);
    expect(readCartCount(page)).toBe(1);
  });

  it("confirms an add when the cart badge appears beside the cart icon (null → 1)", () => {
    const addButton = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });
    const before = obs([addButton, el({ idx: 5, tag: "img", name: "Cart icon", bbox: [900, 10, 30, 30] })]);
    const after = obs([
      el({ idx: 5, tag: "img", name: "Cart icon", bbox: [900, 10, 30, 30] }),
      el({ idx: 6, tag: "strong", name: "1", bbox: [918, 8, 14, 14] }),
    ]);
    expect(addLooksConfirmed(before, after, addButton)).toBe(true);
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

describe("knowledge-aware matching (HyperpureMatchOpts)", () => {
  it("drops a reject-token tile so a clean tile wins findHyperpureProductCard", () => {
    const results = obs(
      [
        el({ idx: 10, tag: "h3", name: "Sponsored - Onion (Big), 10 Kg 10 kg | 4.4 ₹999", bbox: [20, 200, 200, 60] }),
        el({ idx: 11, tag: "h3", name: "Onion (Medium), 5 Kg 5 kg | 4.6 ₹142", bbox: [260, 200, 200, 60] }),
      ],
      "https://www.hyperpure.com/in/search/onion",
    );
    // Without the reject token, the sponsored tile (longer + ₹) could be chosen; with it, it is skipped.
    const card = findHyperpureProductCard(results, onion, { rejectTokens: ["sponsored"] });
    expect(card?.idx).toBe(11);
  });

  it("finds a knowledge atc-token label by EXACT match but not as a substring", () => {
    const page = obs([
      el({ idx: 50, tag: "button", name: "Buy Now", bbox: [300, 240, 90, 40] }),
      el({ idx: 51, tag: "button", name: "Select address", bbox: [40, 40, 90, 40] }),
    ]);
    // "buy now" is an exact-label knowledge token → matched; "address" must NOT match "add" substring-style.
    const found = findHyperpureAddButtons(page, { atcTokens: ["buy now"] });
    expect(found.map((e) => e.idx)).toEqual([50]);
  });

  it("confirms an add via an addedToken phrase near where ADD was", () => {
    const addButton = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });
    const before = obs([addButton]);
    const after = obs([el({ idx: 60, tag: "div", name: "Item in your bag", bbox: [300, 250, 120, 30] })]);
    expect(addLooksConfirmed(before, after, addButton, { addedTokens: ["in your bag"] })).toBe(true);
    // Same DOM without the token knowledge → no built-in pattern matches it → not confirmed.
    expect(addLooksConfirmed(before, after, addButton)).toBe(false);
  });

  it("does NOT confirm on a stray number when no −/+ stepper is present (phantom-success guard)", () => {
    // Reproduces the reported "shows added but cart is empty" bug: after the click the ADD label is gone
    // and a bare integer sits nearby (a re-layout / navigation), but there is no −/+ stepper. That must
    // read as NOT confirmed — the old qty-only fallback here falsely reported success.
    const addButton = el({ idx: 31, tag: "button", name: "ADD +", bbox: [300, 240, 90, 40] });
    const before = obs([addButton]);
    const after = obs([el({ idx: 40, tag: "span", name: "1", bbox: [320, 245, 20, 20] })]);
    expect(addLooksConfirmed(before, after, addButton)).toBe(false);
  });
});

// Fixtures below mirror REAL device-failure DOM digests captured in the eval failure_log, so these are
// regressions against the exact pages the add-to-cart flow silently failed on.
describe("category-rail chip exclusion (failure_log id=2: search 'paneer')", () => {
  const malaiPaneer: RequestedItem = { raw: "malai paneer", name: "Malai Paneer", qty: 1, unit: "kg" };

  // The observed digest was ENTIRELY the left category rail — no product tiles, no ADD, no ₹ prices.
  const categoryRail = obs(
    [
      el({ idx: 6, tag: "div", name: "All", bbox: [0, 100, 180, 40] }),
      el({ idx: 10, tag: "p", name: "All", bbox: [0, 100, 180, 40] }),
      el({ idx: 12, tag: "div", name: "Malai Paneer", bbox: [0, 150, 180, 40] }),
      el({ idx: 16, tag: "p", name: "Malai Paneer", bbox: [0, 150, 180, 40] }),
      el({ idx: 18, tag: "div", name: "Fresh Paneer", bbox: [0, 200, 180, 40] }),
      el({ idx: 24, tag: "div", name: "Low Fat Paneer", bbox: [0, 250, 180, 40] }),
    ],
    "https://www.hyperpure.com/in/search/paneer",
  );

  it("returns null on a chips-only view instead of matching a 'Malai Paneer' category chip", () => {
    // The chip text matches the item perfectly; without the buyable-context gate it would win and the
    // add would click a category link (silent no-op). The gate makes the matcher wait for real tiles.
    expect(findHyperpureProductCard(categoryRail, malaiPaneer)).toBeNull();
  });

  it("picks the real product tile over the identical-text category chip once the grid renders", () => {
    const withTile = obs(
      [
        ...categoryRail.elements,
        el({
          idx: 200,
          tag: "h3",
          name: "Modern Dairy - Malai Paneer, 1 Kg 1 kg | 4.8 (194) ₹332",
          bbox: [400, 200, 240, 80],
        }),
      ],
      "https://www.hyperpure.com/in/search/paneer",
    );
    expect(findHyperpureProductCard(withTile, malaiPaneer)?.idx).toBe(200);
  });
});

describe("buyable-tile selection on a detail page (failure_log id=5: refined sugar)", () => {
  const sugar25: RequestedItem = {
    raw: "zkp refined sugar s-30 25 kg",
    name: "ZKP Refined Sugar S-30 25 Kg",
    qty: 1,
    unit: "kg",
    packSize: "25 kg",
  };

  // The guessed-slug detail page rendered an "explore more" carousel with 10 Kg and 25 Kg variants.
  const page = obs(
    [
      el({ idx: 24, tag: "div", name: "ZKP - Refined Sugar S-30, 10 Kg 10 kg | 4.6 (467)", bbox: [40, 200, 200, 60] }),
      el({ idx: 25, tag: "h3", name: "ZKP - Refined Sugar S-30, 10 Kg", bbox: [40, 200, 200, 40] }),
      el({ idx: 18, tag: "button", name: "ADD +", attrs: { type: "submit" }, bbox: [40, 250, 90, 40] }),
      el({ idx: 46, tag: "div", name: "ZKP - Refined Sugar S-30, 25 Kg 25 kg | 4.8 (257)", bbox: [400, 200, 200, 60] }),
      el({ idx: 47, tag: "h3", name: "ZKP - Refined Sugar S-30, 25 Kg", bbox: [400, 200, 200, 40] }),
      el({ idx: 40, tag: "button", name: "ADD +", attrs: { type: "submit" }, bbox: [400, 250, 90, 40] }),
    ],
    "https://www.hyperpure.com/in/zkp-refined-sugar-s-30-25-kg-25-kg",
  );

  it("matches the 25 Kg tile (pack size), not the 10 Kg variant", () => {
    expect(findHyperpureProductCard(page, sugar25)?.idx).toBe(47);
  });

  it("clicks the ADD button belonging to the matched 25 Kg tile", () => {
    const card = findHyperpureProductCard(page, sugar25)!;
    expect(findAddButtonForCard(page, card)?.idx).toBe(40);
  });
});

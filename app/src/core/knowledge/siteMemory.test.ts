import { describe, expect, it } from "vitest";
import type { SerializedElement } from "../automation/AutomationEngine";
import { SiteMemory, type StorageLike } from "./siteMemory";
import { toSignature } from "./signature";

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function el(p: Partial<SerializedElement> & { idx: number }): SerializedElement {
  return {
    idx: p.idx,
    tag: p.tag ?? "button",
    role: p.role ?? "button",
    name: p.name ?? "ADD",
    value: p.value ?? null,
    bbox: p.bbox ?? [0, 0, 10, 10],
    attrs: p.attrs ?? {},
  };
}

let clock = 0;
const now = (): string => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}Z`;

describe("SiteMemory product URLs", () => {
  it("remembers and recalls a product URL, reinforcing hits on repeat", () => {
    const storage = memStorage();
    const mem = new SiteMemory("hyperpure", { storage, now });
    expect(mem.recallProductUrl("paneer")).toBeUndefined();

    mem.rememberProductUrl("paneer", "https://hp/in/milky-mist-paneer-1-kg", "Milky Mist Paneer 1 Kg");
    expect(mem.recallProductUrl("paneer")?.url).toContain("milky-mist-paneer-1-kg");
    expect(mem.recallProductUrl("paneer")?.hits).toBe(1);

    mem.rememberProductUrl("paneer", "https://hp/in/milky-mist-paneer-1-kg", "Milky Mist Paneer 1 Kg");
    expect(mem.recallProductUrl("paneer")?.hits).toBe(2);
  });

  it("persists across instances via storage", () => {
    const storage = memStorage();
    new SiteMemory("hyperpure", { storage, now }).rememberProductUrl("onion", "https://hp/in/onion-5-kg", "Onion 5 Kg");
    const fresh = new SiteMemory("hyperpure", { storage, now });
    expect(fresh.recallProductUrl("onion")?.url).toContain("onion-5-kg");
  });

  it("isolates memory per platform", () => {
    const storage = memStorage();
    const hp = new SiteMemory("hyperpure", { storage, now });
    hp.rememberProductUrl("x", "https://hp/x", "X");
    const az = new SiteMemory("amazon", { storage, now });
    expect(az.recallProductUrl("x")).toBeUndefined();
  });
});

describe("SiteMemory locators", () => {
  it("learns, reinforces (hits up, confidence recovers after a miss), and recalls the best", () => {
    const storage = memStorage();
    const mem = new SiteMemory("hyperpure", { storage, now });
    const add = el({ idx: 1, name: "ADD" });

    mem.rememberLocator("detail:addToCart", toSignature(add, { at: now() }));
    const first = mem.recallLocator("detail:addToCart");
    expect(first?.namePattern).toBe("add");
    expect(first?.hits).toBe(1);
    expect(first?.confidence).toBe(1); // a fresh learn is already max-confidence

    // A miss decays it; re-learning the same control reinforces hits AND recovers confidence.
    mem.penalizeLocator("detail:addToCart", first!);
    const decayed = mem.recallLocator("detail:addToCart");
    expect(decayed!.confidence).toBeLessThan(1);

    mem.rememberLocator("detail:addToCart", toSignature(add, { at: now() }));
    const reinforced = mem.recallLocator("detail:addToCart");
    expect(reinforced?.hits).toBe(2);
    expect(reinforced!.confidence).toBeGreaterThan(decayed!.confidence);
  });

  it("penalizing a stale signature decays it and eventually drops it", () => {
    const storage = memStorage();
    const mem = new SiteMemory("hyperpure", { storage, now });
    const sig = toSignature(el({ idx: 1, name: "ADD" }), { at: now() });
    mem.rememberLocator("detail:addToCart", sig);

    // Several misses drive confidence below the floor → forgotten.
    mem.penalizeLocator("detail:addToCart", sig);
    mem.penalizeLocator("detail:addToCart", sig);
    mem.penalizeLocator("detail:addToCart", sig);
    expect(mem.recallLocator("detail:addToCart")).toBeUndefined();
  });
});

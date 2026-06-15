import { describe, expect, it } from "vitest";
import type { Observation, SerializedElement } from "../automation/AutomationEngine";
import { matchSignature, scoreSignature, toSignature } from "./signature";

function el(p: Partial<SerializedElement> & { idx: number }): SerializedElement {
  return {
    idx: p.idx,
    tag: p.tag ?? "div",
    role: p.role ?? null,
    name: p.name ?? "",
    value: p.value ?? null,
    bbox: p.bbox ?? [0, 0, 10, 10],
    attrs: p.attrs ?? {},
  };
}

function obs(elements: SerializedElement[]): Observation {
  return { url: "https://x", title: "", scroll: { y: 0, h: 0, vh: 0 }, elements };
}

describe("toSignature", () => {
  it("captures durable fields and normalises the name", () => {
    const sig = toSignature(
      el({ idx: 3, tag: "input", role: "searchbox", name: "  Search Items  ", attrs: { type: "search" }, bbox: [10, 20, 100, 40] }),
      { at: "2026-01-01T00:00:00Z" },
    );
    expect(sig.tag).toBe("input");
    expect(sig.role).toBe("searchbox");
    expect(sig.namePattern).toBe("search items");
    expect(sig.attrType).toBe("search");
    expect(sig.hasHref).toBe(false);
    expect(sig.cx).toBe(60); // 10 + 100/2
    expect(sig.confidence).toBe(1);
    expect(sig.hits).toBe(1);
  });
});

describe("matchSignature", () => {
  const sig = toSignature(
    el({ idx: 1, tag: "button", role: "button", name: "ADD", bbox: [100, 200, 60, 30] }),
  );

  it("re-finds the same control even when idx changed and it moved slightly", () => {
    const page = obs([
      el({ idx: 9, tag: "div", name: "Milky Mist Paneer 1 Kg" }),
      el({ idx: 10, tag: "button", role: "button", name: "ADD", bbox: [105, 205, 60, 30] }),
    ]);
    const found = matchSignature(page, sig);
    expect(found?.idx).toBe(10);
  });

  it("rejects when the tag differs (never click the wrong kind of control)", () => {
    const page = obs([el({ idx: 4, tag: "a", role: "link", name: "ADD" })]);
    expect(matchSignature(page, sig)).toBeNull();
  });

  it("rejects when the learned name does not overlap at all", () => {
    const page = obs([el({ idx: 4, tag: "button", role: "button", name: "Checkout" })]);
    expect(matchSignature(page, sig)).toBeNull();
  });

  it("scores an exact name+role+tag match higher than a partial one", () => {
    const exact = el({ idx: 1, tag: "button", role: "button", name: "ADD", bbox: [100, 200, 60, 30] });
    const partial = el({ idx: 2, tag: "button", role: "button", name: "ADD +", bbox: [800, 900, 60, 30] });
    expect(scoreSignature(exact, sig)).toBeGreaterThan(scoreSignature(partial, sig));
  });
});

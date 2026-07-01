import { describe, expect, it } from "vitest";
import { buildTokenMatcher } from "./tokenMatcher";

const BASE = /add to (?:cart|basket)/i;

describe("buildTokenMatcher", () => {
  it("returns the base regex unchanged when no tokens are given", () => {
    expect(buildTokenMatcher(BASE, undefined)).toBe(BASE);
    expect(buildTokenMatcher(BASE, [])).toBe(BASE);
    expect(buildTokenMatcher(BASE, ["", "  "])).toBe(BASE);
  });

  it("still matches the base pattern after extending", () => {
    const m = buildTokenMatcher(BASE, ["add +"]);
    expect(m.test("Add to Cart")).toBe(true);
  });

  it("matches the extra tokens case-insensitively", () => {
    const m = buildTokenMatcher(BASE, ["ADD +", "in your bag"]);
    expect(m.test("add +")).toBe(true);
    expect(m.test("Now IN YOUR BAG")).toBe(true);
    expect(m.test("totally unrelated")).toBe(false);
  });

  it("escapes regex metacharacters in tokens", () => {
    const m = buildTokenMatcher(BASE, ["add (1+1)"]);
    expect(m.test("add (1+1)")).toBe(true);
    // The '+' must be literal, not a quantifier: a different string must not match.
    expect(m.test("add 11")).toBe(false);
  });
});

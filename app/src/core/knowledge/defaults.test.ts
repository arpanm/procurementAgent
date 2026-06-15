import { describe, expect, it } from "vitest";
import { SUPPORTED_PLATFORMS } from "../domain/types";
import { DEFAULT_KNOWLEDGE, defaultKnowledge } from "./defaults";

describe("DEFAULT_KNOWLEDGE", () => {
  it("has a curated default doc for every supported platform", () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      const doc = DEFAULT_KNOWLEDGE[platform];
      expect(doc).toBeDefined();
      expect(doc.platform).toBe(platform);
    }
  });

  it("uses detail-page pricing for Amazon", () => {
    expect(DEFAULT_KNOWLEDGE.amazon.policies.priceFromDetailPage).toBe(true);
    expect(DEFAULT_KNOWLEDGE.amazon.policies.trustListingPrice).toBe(false);
  });

  it("trusts the listing price for Hyperpure", () => {
    expect(DEFAULT_KNOWLEDGE.hyperpure.policies.trustListingPrice).toBe(true);
    expect(DEFAULT_KNOWLEDGE.hyperpure.policies.priceFromDetailPage).toBe(false);
  });
});

describe("defaultKnowledge", () => {
  it("returns a deep copy that does not alias DEFAULT_KNOWLEDGE", () => {
    const copy = defaultKnowledge("amazon");

    copy.version = 999;
    copy.policies.priceFromDetailPage = false;
    copy.hints.rejectTokens.push("MUTATED");
    copy.notes.push({ at: "now", kind: "test", text: "mutated" });

    expect(DEFAULT_KNOWLEDGE.amazon.version).toBe(1);
    expect(DEFAULT_KNOWLEDGE.amazon.policies.priceFromDetailPage).toBe(true);
    expect(DEFAULT_KNOWLEDGE.amazon.hints.rejectTokens).not.toContain("MUTATED");
    expect(DEFAULT_KNOWLEDGE.amazon.notes).toHaveLength(0);
  });

  it("returns equal-but-distinct objects on each call", () => {
    const a = defaultKnowledge("hyperpure");
    const b = defaultKnowledge("hyperpure");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.hints).not.toBe(b.hints);
  });
});

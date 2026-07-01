import { describe, expect, it, vi } from "vitest";
import type { KnowledgeDoc } from "./PlatformKnowledge";
import { DefaultKnowledgeStore, type KnowledgeTransport } from "./PlatformKnowledgeStore";

function validDoc(): KnowledgeDoc {
  return {
    platform: "amazon",
    version: 7,
    policies: { priceFromDetailPage: true, trustListingPrice: false },
    hints: {
      rejectTokens: ["sponsored"],
      processedVariantTokens: ["powder"],
      atcTokens: ["add to cart"],
      addedTokens: ["added to cart"],
      searchNotes: ["custom note"],
    },
    notes: [{ at: "2026-01-01T00:00:00.000Z", kind: "seed", text: "hello" }],
  };
}

describe("DefaultKnowledgeStore.getKnowledge", () => {
  it("returns the built-in default when no transport is configured", async () => {
    const store = new DefaultKnowledgeStore();
    const doc = await store.getKnowledge("amazon");

    expect(doc.platform).toBe("amazon");
    expect(doc.version).toBe(1);
    expect(doc.policies.priceFromDetailPage).toBe(true);
  });

  it("returns a backend doc and caches it (no second transport call)", async () => {
    const get = vi.fn(async () => validDoc());
    const transport: KnowledgeTransport = { get, post: vi.fn(async () => undefined) };
    const store = new DefaultKnowledgeStore({ transport });

    const first = await store.getKnowledge("amazon");
    const second = await store.getKnowledge("amazon");

    expect(first.version).toBe(7);
    expect(first.hints.searchNotes).toEqual(["custom note"]);
    expect(second).toBe(first);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/knowledge/amazon");
  });

  it("falls back to the default and does not throw when the transport rejects", async () => {
    const transport: KnowledgeTransport = {
      get: vi.fn(async () => {
        throw new Error("network down");
      }),
      post: vi.fn(async () => undefined),
    };
    const store = new DefaultKnowledgeStore({ transport });

    const doc = await store.getKnowledge("hyperpure");

    expect(doc.platform).toBe("hyperpure");
    expect(doc.version).toBe(2);
    expect(doc.policies.trustListingPrice).toBe(true);
  });

  it("normalizes a partial/garbage payload into a fully-populated doc", async () => {
    const transport: KnowledgeTransport = {
      get: vi.fn(async () => ({
        version: "not-a-number",
        policies: { priceFromDetailPage: "yes" },
        hints: { rejectTokens: ["junk", 42], atcTokens: "nope" },
        notes: "garbage",
      })),
      post: vi.fn(async () => undefined),
    };
    const store = new DefaultKnowledgeStore({ transport });

    const doc = await store.getKnowledge("amazon");

    expect(doc.platform).toBe("amazon");
    expect(doc.version).toBe(1); // filled from default (non-number rejected)
    expect(typeof doc.policies.priceFromDetailPage).toBe("boolean");
    expect(doc.policies.priceFromDetailPage).toBe(true); // default (non-boolean rejected)
    expect(doc.hints.rejectTokens).toEqual(["junk"]); // non-strings dropped
    expect(Array.isArray(doc.hints.atcTokens)).toBe(true); // filled from default
    expect(doc.hints.atcTokens.length).toBeGreaterThan(0);
    expect(Array.isArray(doc.hints.processedVariantTokens)).toBe(true);
    expect(Array.isArray(doc.hints.addedTokens)).toBe(true);
    expect(Array.isArray(doc.hints.searchNotes)).toBe(true);
    expect(Array.isArray(doc.notes)).toBe(true);
  });
});

describe("DefaultKnowledgeStore.recordObservation", () => {
  it("posts to the right path", async () => {
    const post = vi.fn(async () => undefined);
    const transport: KnowledgeTransport = { get: vi.fn(async () => validDoc()), post };
    const store = new DefaultKnowledgeStore({ transport });

    await store.recordObservation("amazon", { kind: "price-mismatch", text: "off by 10" });

    expect(post).toHaveBeenCalledWith("/knowledge/amazon/observations", {
      kind: "price-mismatch",
      text: "off by 10",
    });
  });

  it("appends to the cached doc when present", async () => {
    const transport: KnowledgeTransport = {
      get: vi.fn(async () => validDoc()),
      post: vi.fn(async () => undefined),
    };
    const store = new DefaultKnowledgeStore({ transport });

    const doc = await store.getKnowledge("amazon");
    const before = doc.notes.length;
    await store.recordObservation("amazon", { kind: "drift", text: "selector changed" });

    expect(doc.notes.length).toBe(before + 1);
    expect(doc.notes[doc.notes.length - 1]).toMatchObject({
      kind: "drift",
      text: "selector changed",
    });
  });

  it("never throws even when the transport rejects", async () => {
    const transport: KnowledgeTransport = {
      get: vi.fn(async () => validDoc()),
      post: vi.fn(async () => {
        throw new Error("post failed");
      }),
    };
    const store = new DefaultKnowledgeStore({ transport });

    await expect(
      store.recordObservation("hyperpure", { kind: "x", text: "y" }),
    ).resolves.toBeUndefined();
  });
});

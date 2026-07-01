/**
 * Built-in curated defaults for the per-platform GUIDED-RAG KNOWLEDGE layer.
 *
 * These ship with the app so every platform agent has sane extraction hints + policies even with no
 * backend (offline / demo). The backend `/knowledge` endpoint can override these at runtime, but the
 * store always falls back here on any error. Keep these byte-for-byte in sync with the backend seed.
 */
import type { PlatformId } from "../domain/types";
import type { KnowledgeDoc } from "./PlatformKnowledge";

export const DEFAULT_KNOWLEDGE: Record<PlatformId, KnowledgeDoc> = {
  amazon: {
    platform: "amazon",
    version: 1,
    policies: { priceFromDetailPage: true, trustListingPrice: false },
    hints: {
      rejectTokens: ["sponsored", "apply the filter", "narrow results", "sort by", "did you mean"],
      processedVariantTokens: [
        "dehydrated",
        "dried",
        "flakes",
        "powder",
        "paste",
        "pickle",
        "sauce",
        "ketchup",
        "seeds",
        "sapling",
        "plant",
        "combo",
        "kit",
      ],
      atcTokens: ["add to cart", "add to basket", "add to bag", "buy now"],
      addedTokens: ["added to cart", "cart subtotal", "proceed to checkout", "go to cart"],
      searchNotes: [
        "Amazon listing prices are unreliable; open the product detail page for the buybox price.",
      ],
    },
    notes: [],
  },
  hyperpure: {
    platform: "hyperpure",
    version: 2,
    policies: { priceFromDetailPage: false, trustListingPrice: true },
    hints: {
      rejectTokens: ["sponsored"],
      processedVariantTokens: [],
      atcTokens: ["add", "add +"],
      addedTokens: ["added", "in cart", "increase", "decrease", "remove", "qty"],
      searchNotes: [
        "Hyperpure grid is virtualized; read the listing via screenshot+vision.",
        "Add-to-cart: each product tile (listing) and the product detail page carry a red 'ADD +' control. Both the listing tile and the detail page can add the item — the listing tile is the more reliable target because the detail-page slug is often guessed and 404s.",
        "After a successful ADD, the 'ADD +' control is replaced IN PLACE by a quantity stepper '− <qty> +'. Confirm the add by the stepper appearing (or the header cart badge incrementing), NOT by assuming the click worked.",
        "Raise quantity by clicking the stepper '+' (qty − 1) more times; the '+'/'−' may render as icon buttons (accessible name 'increase'/'decrease') rather than literal '+'/'−' glyphs.",
        "The detail page also shows tiered-pricing rows ('₹X/kg for N kgs+  Add N'). Those 'Add N' buttons jump straight to a bulk quantity; the plain bottom 'ADD' adds the base pack — prefer the plain ADD for an exact-quantity order.",
      ],
    },
    notes: [],
  },
};

/** Returns a deep copy of the curated default doc for `platform`, safe for the caller to mutate. */
export function defaultKnowledge(platform: PlatformId): KnowledgeDoc {
  const base = DEFAULT_KNOWLEDGE[platform];
  return {
    platform: base.platform,
    version: base.version,
    policies: { ...base.policies },
    hints: {
      rejectTokens: [...base.hints.rejectTokens],
      processedVariantTokens: [...base.hints.processedVariantTokens],
      atcTokens: [...base.hints.atcTokens],
      addedTokens: [...base.hints.addedTokens],
      searchNotes: [...base.hints.searchNotes],
    },
    notes: base.notes.map((n) => ({ ...n })),
  };
}

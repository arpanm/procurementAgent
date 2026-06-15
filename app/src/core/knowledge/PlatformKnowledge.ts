/**
 * Per-platform GUIDED-RAG KNOWLEDGE layer — shared contracts (frontend half).
 *
 * Each platform agent is handed a curated {@link KnowledgeDoc}: learned extraction hints (which tokens
 * to reject, which signal a processed variant, how add-to-cart reads, etc.) plus a small set of
 * read-strategy policies. Docs are served by the backend `/knowledge` endpoint but always have a
 * built-in default fallback, so the agents work offline / in demo without a backend.
 *
 * The schema mirrors the backend half byte-for-byte (camelCase). Do not reorder/rename fields.
 */
import type { PlatformId } from "../domain/types";

/** A single observation recorded against a platform's knowledge doc (newest appended last). */
export interface KnowledgeNote {
  /** ISO timestamp of when the observation was recorded. */
  at: string;
  /** Coarse category of the observation, e.g. "price-mismatch", "selector-drift". */
  kind: string;
  /** Free-form human/agent-readable description. */
  text: string;
}

/** Read-strategy policies that steer how an agent extracts a price for this platform. */
export interface KnowledgePolicies {
  /** Open the product detail page and read the buybox price (listing price is unreliable). */
  priceFromDetailPage: boolean;
  /** The listing/grid price is authoritative; no need to open the detail page. */
  trustListingPrice: boolean;
}

/** Curated extraction hints the agent uses to interpret a platform's DOM/screenshots. */
export interface KnowledgeHints {
  /** Tokens whose presence means a result/row is noise and should be rejected. */
  rejectTokens: string[];
  /** Tokens that flag a processed/derived variant (so it isn't matched as the raw item). */
  processedVariantTokens: string[];
  /** Tokens that identify an add-to-cart affordance. */
  atcTokens: string[];
  /** Tokens that confirm an item was successfully added to the cart. */
  addedTokens: string[];
  /** Free-form notes about how to search/read this platform. */
  searchNotes: string[];
}

/** The full curated knowledge document for one platform. */
export interface KnowledgeDoc {
  platform: PlatformId;
  /** Monotonic version of the curated doc; bumped when curation changes. */
  version: number;
  policies: KnowledgePolicies;
  hints: KnowledgeHints;
  notes: KnowledgeNote[];
}

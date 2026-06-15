package ai.procurecopilot.backend.knowledge;

/**
 * Curated per-platform extraction policies (PROCURE_COPILOT_PLAN.md guided-RAG knowledge layer).
 * {@code priceFromDetailPage} tells the device to open the product detail page for an authoritative
 * price; {@code trustListingPrice} tells it the grid/listing price is reliable. Serialized via
 * camelCase Jackson record components to match the frontend half byte-for-byte.
 */
public record KnowledgePolicies(boolean priceFromDetailPage, boolean trustListingPrice) {}

package ai.procurecopilot.backend.knowledge;

import java.util.List;

/**
 * Curated per-platform extraction hints (PROCURE_COPILOT_PLAN.md guided-RAG knowledge layer). These
 * are token lists the device uses to classify page content during search/extraction: tokens that
 * signal a result should be rejected, processed-variant tokens (dried/powder/...), add-to-cart and
 * added-to-cart confirmation tokens, and free-form search notes. Null lists are normalized to empty
 * so the JSON contract is stable. Serialized via camelCase Jackson record components.
 */
public record KnowledgeHints(
        List<String> rejectTokens,
        List<String> processedVariantTokens,
        List<String> atcTokens,
        List<String> addedTokens,
        List<String> searchNotes) {

    public KnowledgeHints {
        rejectTokens = rejectTokens == null ? List.of() : List.copyOf(rejectTokens);
        processedVariantTokens =
                processedVariantTokens == null ? List.of() : List.copyOf(processedVariantTokens);
        atcTokens = atcTokens == null ? List.of() : List.copyOf(atcTokens);
        addedTokens = addedTokens == null ? List.of() : List.copyOf(addedTokens);
        searchNotes = searchNotes == null ? List.of() : List.copyOf(searchNotes);
    }
}

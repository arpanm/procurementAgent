package ai.procurecopilot.backend.knowledge;

import java.util.List;

/**
 * The full curated knowledge document for one platform (PROCURE_COPILOT_PLAN.md guided-RAG
 * knowledge layer): seed {@link KnowledgePolicies} + {@link KnowledgeHints} plus an appendable
 * {@link KnowledgeNote} corpus (the "RAG" learnings the device contributes). {@code platform} is the
 * lowercase wire string ("amazon" / "hyperpure"). Null notes are normalized to empty. Serialized via
 * camelCase Jackson record components to match the frontend half byte-for-byte.
 */
public record KnowledgeDoc(
        String platform,
        int version,
        KnowledgePolicies policies,
        KnowledgeHints hints,
        List<KnowledgeNote> notes) {

    public KnowledgeDoc {
        notes = notes == null ? List.of() : List.copyOf(notes);
    }
}

package ai.procurecopilot.backend.knowledge;

/**
 * A single appended observation in a platform's RAG corpus (PROCURE_COPILOT_PLAN.md guided-RAG
 * knowledge layer). {@code at} is an ISO-8601 instant string captured when the device records the
 * learning; {@code kind} is a free-form tag ("selector", "note", ...) and {@code text} is the
 * learning itself. Serialized via camelCase Jackson record components to match the frontend half.
 */
public record KnowledgeNote(String at, String kind, String text) {}

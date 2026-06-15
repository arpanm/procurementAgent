package ai.procurecopilot.backend.knowledge;

/**
 * Request body for appending an observation to a platform's RAG corpus
 * (POST /knowledge/{platform}/observations). {@code kind} is a free-form tag ("selector", "note",
 * ...) and {@code text} is the learning; both are required (the controller rejects blanks with 400).
 */
public record ObservationRequest(String kind, String text) {}

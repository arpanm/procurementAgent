package ai.procurecopilot.backend.agent;

/**
 * Conversation-layer request for slot extraction (PROCURE_COPILOT_PLAN.md Epic 1). {@code text} is
 * the raw vernacular Hindi/Bengali/English utterance; {@code locale} is an optional hint like
 * "hi-IN" / "bn-IN" / "en-IN".
 */
public record IntentRequest(String text, String locale) {
}

package ai.procurecopilot.backend.llm;

/**
 * A deterministic stub responder for a single agent {@code task}. Each epic registers its own
 * responder bean (e.g. intent, next-action) so the full agent loop runs in CI without a live key.
 * In production ({@code anthropic.stub-mode=false} + key present) these are bypassed for real calls.
 */
public interface ClaudeResponder {

    /** The task this responder handles, matching {@link ClaudeRequest#task()}. */
    String task();

    /** Produce a deterministic response for the request. */
    String respond(ClaudeRequest request);
}

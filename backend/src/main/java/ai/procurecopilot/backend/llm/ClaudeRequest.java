package ai.procurecopilot.backend.llm;

/**
 * A single reasoning request to Claude. {@code task} names the agent function (e.g. "intent",
 * "plan", "next-action", "verify", "narrate") so stub responders can be dispatched deterministically
 * in CI and so telemetry can attribute cost per function.
 */
public record ClaudeRequest(String task, String system, String user, Integer maxTokens) {

    public ClaudeRequest {
        if (task == null || task.isBlank()) {
            throw new IllegalArgumentException("task is required");
        }
    }
}

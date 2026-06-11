package ai.procurecopilot.backend.llm;

/**
 * A single reasoning request to Claude. {@code task} names the agent function (e.g. "intent",
 * "plan", "next-action", "verify", "narrate", "vision-extract") so stub responders can be dispatched
 * deterministically in CI and so telemetry can attribute cost per function.
 *
 * <p>{@code imageBase64}/{@code imageMediaType} are optional: when present the request is multimodal
 * (a base64 image block is sent alongside the {@code user} text), used by the screenshot-based
 * vision-extract path for SPA listings whose DOM is too large to serialize reliably.
 */
public record ClaudeRequest(
        String task,
        String system,
        String user,
        Integer maxTokens,
        String imageBase64,
        String imageMediaType) {

    public ClaudeRequest {
        if (task == null || task.isBlank()) {
            throw new IllegalArgumentException("task is required");
        }
    }

    /** Text-only request (the common case). */
    public ClaudeRequest(String task, String system, String user, Integer maxTokens) {
        this(task, system, user, maxTokens, null, null);
    }

    public boolean hasImage() {
        return imageBase64 != null && !imageBase64.isBlank();
    }
}

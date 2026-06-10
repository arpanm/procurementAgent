package ai.procurecopilot.backend.llm;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Anthropic configuration (PROCURE_COPILOT_PLAN.md §3.2). The API key is supplied via environment
 * only, lives off-device, and is never logged. A single strong model serves planner, grounder,
 * intent and verifier in MVP (no tiering).
 */
@ConfigurationProperties(prefix = "anthropic")
public record AnthropicProperties(
        String baseUrl,
        String apiKey,
        String version,
        String model,
        Integer maxTokens,
        Boolean stubMode) {

    public boolean isStub() {
        return stubMode == null || stubMode || apiKey == null || apiKey.isBlank();
    }

    public int maxTokensOrDefault() {
        return maxTokens == null ? 2048 : maxTokens;
    }
}

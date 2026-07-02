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
        // Explicit opt-out: STUB_MODE=false means "use the live API." We must NOT silently fall back to
        // deterministic stub completions just because the key is missing/mis-injected — that would serve
        // fabricated products and prices to a production deployment. A blank key with stub-mode=false is
        // caught loudly at boot (AnthropicStartupProbe) instead.
        if (stubMode != null && !stubMode) {
            return false;
        }
        // Stub when explicitly enabled, unset, or when no key is configured (safe offline default).
        return stubMode == null || stubMode || apiKey == null || apiKey.isBlank();
    }

    /** True when a non-blank Anthropic key is configured. */
    public boolean hasApiKey() {
        return apiKey != null && !apiKey.isBlank();
    }

    /** Live mode explicitly requested but no key present — a fatal mis-configuration for production. */
    public boolean isLiveModeMissingKey() {
        return stubMode != null && !stubMode && !hasApiKey();
    }

    public int maxTokensOrDefault() {
        return maxTokens == null ? 2048 : maxTokens;
    }
}

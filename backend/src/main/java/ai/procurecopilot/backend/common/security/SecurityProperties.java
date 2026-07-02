package ai.procurecopilot.backend.common.security;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Backend API-auth configuration ({@code procure.security.*}).
 *
 * <p>The backend proxies the (billable) Anthropic key and mutates the knowledge/playbook corpus that
 * devices download and execute, so it must not be an open surface. When {@code api-token} is set, every
 * request must present {@code Authorization: Bearer <token>} (see {@link ApiTokenAuthFilter}). When it is
 * blank — local dev, CI, the demo — auth is disabled so the existing flow and tests run unchanged. The
 * {@code prod} profile requires the token (no default), so production fails to start without it.
 *
 * <p>{@code operator-token}, when set, is required for the risky operator-only mutations (promote/reject a
 * gated patch, force an eval run, push a playbook); device-facing writes (failure reports, observations)
 * only need the ordinary api token.
 */
@ConfigurationProperties(prefix = "procure.security")
public record SecurityProperties(String apiToken, String operatorToken, Integer rateLimitPerMinute) {

    /** Auth is enforced only when an api token is configured (off for local/dev/test). */
    public boolean enabled() {
        return apiToken != null && !apiToken.isBlank();
    }

    public boolean matchesApiToken(String presented) {
        return constantTimeEquals(apiToken, presented);
    }

    /** Operator endpoints accept the operator token; if none is configured they fall back to the api token. */
    public boolean matchesOperatorToken(String presented) {
        String required = (operatorToken != null && !operatorToken.isBlank()) ? operatorToken : apiToken;
        return constantTimeEquals(required, presented);
    }

    public int rateLimitPerMinuteOrDefault() {
        return rateLimitPerMinute == null || rateLimitPerMinute <= 0 ? 120 : rateLimitPerMinute;
    }

    /** Constant-time comparison so a token can't be recovered by timing. */
    private static boolean constantTimeEquals(String secret, String presented) {
        if (secret == null || secret.isBlank() || presented == null) {
            return false;
        }
        return MessageDigest.isEqual(
                secret.getBytes(StandardCharsets.UTF_8),
                presented.getBytes(StandardCharsets.UTF_8));
    }
}

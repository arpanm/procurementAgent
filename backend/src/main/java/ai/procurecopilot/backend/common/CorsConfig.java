package ai.procurecopilot.backend.common;

import jakarta.annotation.PostConstruct;
import java.util.Arrays;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * CORS for the device app. The app runs from a different origin than the backend — the Vite dev
 * server (e.g. http://localhost:5173) during development, and the Capacitor WebView
 * (capacitor://localhost / http://localhost / https://localhost) on Android — so the browser/WebView
 * needs CORS headers to call the API.
 *
 * <p>Origins are configurable via {@code procure.cors.allowed-origins} (comma-separated origin
 * patterns). The default is permissive ({@code *}) for easy local/dev use; lock it down to your app
 * origins in production. We do not use cookies/credentials (the device holds its own session and the
 * Anthropic key never reaches the app), so origin patterns with {@code *} are safe here.
 */
@Configuration
public class CorsConfig implements WebMvcConfigurer {

    private final String[] allowedOriginPatterns;
    private final Environment env;

    public CorsConfig(
            @Value("${procure.cors.allowed-origins:*}") String allowedOrigins,
            Environment env) {
        this.allowedOriginPatterns = allowedOrigins.split("\\s*,\\s*");
        this.env = env;
    }

    /**
     * Fail closed in production: a wildcard (or blank) CORS origin under the {@code prod} profile means
     * any website in a user's browser could script the API. Refuse to start so a mis-configured deploy is
     * caught at boot instead of shipping an open cross-origin surface.
     */
    @PostConstruct
    void rejectWildcardInProduction() {
        boolean prod = Arrays.asList(env.getActiveProfiles()).contains("prod");
        if (!prod) {
            return;
        }
        for (String pattern : allowedOriginPatterns) {
            if (pattern == null || pattern.isBlank() || pattern.trim().equals("*")) {
                throw new IllegalStateException(
                        "procure.cors.allowed-origins must be an explicit list under the 'prod' profile "
                        + "(never '*' or blank). Set PROCURE_CORS_ALLOWED_ORIGINS to your app origins, "
                        + "e.g. 'capacitor://localhost,https://localhost'.");
            }
        }
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns(allowedOriginPatterns)
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(false)
                .maxAge(3600);
    }
}

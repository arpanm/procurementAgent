package ai.procurecopilot.backend.common;

import org.springframework.beans.factory.annotation.Value;
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

    public CorsConfig(
            @Value("${procure.cors.allowed-origins:*}") String allowedOrigins) {
        this.allowedOriginPatterns = allowedOrigins.split("\\s*,\\s*");
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

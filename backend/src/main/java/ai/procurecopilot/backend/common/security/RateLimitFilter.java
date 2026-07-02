package ai.procurecopilot.backend.common.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Coarse fixed-window rate limiter for the billable LLM-backed endpoints, to blunt quota-drain abuse
 * (B1). Active only when API auth is enabled (prod-like); off for local/CI/demo. Keyed by bearer token
 * (falling back to client IP), {@code rateLimitPerMinute} requests per minute per key.
 *
 * <p>This is a single-instance limiter — good enough for one node as a first go-live gate. For a
 * multi-replica deployment put a shared limiter (gateway / Redis / bucket4j-hazelcast) in front.
 */
@Component
@Order(2)
public class RateLimitFilter extends OncePerRequestFilter {

    /** The metered, Anthropic-spending (or otherwise expensive) endpoints. */
    private static final Set<String> LIMITED_PATHS = Set.of(
            "/intent", "/plan", "/next-action", "/vision/extract", "/verify", "/optimize");

    private final SecurityProperties props;
    private final Clock clock;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public RateLimitFilter(SecurityProperties props, Clock clock) {
        this.props = props;
        this.clock = clock;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (!props.enabled() || !LIMITED_PATHS.contains(req.getRequestURI())) {
            chain.doFilter(req, res);
            return;
        }

        long minute = clock.millis() / 60_000L;
        String key = clientKey(req);
        Window window = windows.compute(key, (k, existing) -> {
            if (existing == null || existing.minute != minute) {
                return new Window(minute);
            }
            return existing;
        });
        int count = window.count.incrementAndGet();
        if (count > props.rateLimitPerMinuteOrDefault()) {
            res.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            res.setContentType(MediaType.APPLICATION_JSON_VALUE);
            res.setHeader("Retry-After", "60");
            res.getWriter().write("{\"error\":\"rate_limited\",\"detail\":\"too many requests\"}");
            return;
        }
        chain.doFilter(req, res);
    }

    private static String clientKey(HttpServletRequest req) {
        String header = req.getHeader(HttpHeaders.AUTHORIZATION);
        if (header != null && !header.isBlank()) {
            return "t:" + Integer.toHexString(header.hashCode());
        }
        return "ip:" + req.getRemoteAddr();
    }

    private static final class Window {
        private final long minute;
        private final AtomicInteger count = new AtomicInteger(0);

        private Window(long minute) {
            this.minute = minute;
        }
    }
}

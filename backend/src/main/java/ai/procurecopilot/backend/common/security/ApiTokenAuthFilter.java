package ai.procurecopilot.backend.common.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Bearer-token gate for the whole API (B1). No token configured ⇒ pass-through (dev/CI/demo). Otherwise
 * every request needs {@code Authorization: Bearer <token>}, except CORS preflight ({@code OPTIONS}) and
 * the health probe. Operator-only mutations (promote/reject a gated patch, force an eval run, push a
 * playbook) additionally require the operator token; device-facing writes (failure reports, knowledge
 * observations) only need the ordinary api token.
 */
@Component
@Order(1)
public class ApiTokenAuthFilter extends OncePerRequestFilter {

    private static final String BEARER = "Bearer ";

    private final SecurityProperties props;

    public ApiTokenAuthFilter(SecurityProperties props) {
        this.props = props;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (!props.enabled() || isPublic(req)) {
            chain.doFilter(req, res);
            return;
        }

        String token = bearerToken(req);
        boolean authorized = isOperatorRequest(req)
                ? props.matchesOperatorToken(token)
                : props.matchesApiToken(token);
        if (!authorized) {
            reject(res, isOperatorRequest(req));
            return;
        }
        chain.doFilter(req, res);
    }

    /** CORS preflight and the health probe are always open. */
    private boolean isPublic(HttpServletRequest req) {
        if ("OPTIONS".equalsIgnoreCase(req.getMethod())) {
            return true;
        }
        String path = req.getRequestURI();
        return path.equals("/actuator/health") || path.startsWith("/actuator/health/");
    }

    /**
     * Risky operator-only mutations. Deliberately narrow so the DEVICE keeps working with the ordinary
     * token: POST /eval/{p}/failures and POST /knowledge/{p}/observations are device writes and are NOT
     * operator-gated.
     */
    private boolean isOperatorRequest(HttpServletRequest req) {
        String path = req.getRequestURI();
        String method = req.getMethod();
        boolean promoteOrReject = path.contains("/pending/")
                && (path.endsWith("/promote") || path.endsWith("/reject"));
        boolean forceEvalRun = path.startsWith("/eval/") && path.endsWith("/run");
        boolean pushPlaybook = path.startsWith("/playbooks") && !"GET".equalsIgnoreCase(method);
        return promoteOrReject || forceEvalRun || pushPlaybook;
    }

    private static String bearerToken(HttpServletRequest req) {
        String header = req.getHeader(HttpHeaders.AUTHORIZATION);
        if (header != null && header.regionMatches(true, 0, BEARER, 0, BEARER.length())) {
            return header.substring(BEARER.length()).trim();
        }
        return null;
    }

    private static void reject(HttpServletResponse res, boolean operator) throws IOException {
        res.setStatus(HttpStatus.UNAUTHORIZED.value());
        res.setContentType(MediaType.APPLICATION_JSON_VALUE);
        String msg = operator
                ? "operator token required for this endpoint"
                : "missing or invalid Authorization: Bearer token";
        res.getWriter().write("{\"error\":\"unauthorized\",\"detail\":\"" + msg + "\"}");
    }
}

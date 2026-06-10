package ai.procurecopilot.backend.session;

import java.util.List;
import java.util.Map;

/**
 * Read model for {@code GET /sessions/{id}} (PROCURE_COPILOT_PLAN.md §3.6.5): the full event log plus
 * the latest-state projection, used by the device to hydrate on cold start.
 */
public record SessionView(String id, List<SessionEvent> events, Map<String, Object> projection) {
}

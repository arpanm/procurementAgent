package ai.procurecopilot.backend.session;

import java.util.Map;

/**
 * Body for {@code POST /sessions/{id}/events} (PROCURE_COPILOT_PLAN.md §3.6.4). {@code clientEventId}
 * is optional; when present it dedupes safe retries from the device's local outbox.
 */
public record AppendEventRequest(String type, Map<String, Object> payload, String clientEventId) {
}

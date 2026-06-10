package ai.procurecopilot.backend.session;

import java.time.Instant;
import java.util.Map;

/**
 * One immutable entry in a session's append-only event log (PROCURE_COPILOT_PLAN.md §3.6.4). {@code
 * seq} is monotonic per session (assigned by the store); {@code payload} is an opaque domain-event
 * body. The event log is the durable system of record for a procurement run.
 */
public record SessionEvent(long seq, String type, Map<String, Object> payload, Instant at) {
}

package ai.procurecopilot.backend.telemetry;

import java.time.Instant;
import java.util.Map;

/**
 * A step-level trace span (PROCURE_COPILOT_PLAN.md §5 Observability, Epic 7). Shaped like an OTel span
 * (name + attributes + timing) so a real OpenTelemetry/Langfuse exporter can drop in later without
 * changing call sites. {@code task} attributes the agent function (e.g. "next-action", "verify").
 */
public record TraceSpan(
        String name,
        String task,
        String sessionId,
        Map<String, Object> attributes,
        Instant at,
        Long durationMs) {
}

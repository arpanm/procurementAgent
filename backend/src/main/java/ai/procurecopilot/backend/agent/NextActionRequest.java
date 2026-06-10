package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.PlatformId;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Grounding input (PROCURE_COPILOT_PLAN.md §3.5.4, Epic 6). The device posts a PII-scrubbed serialized
 * observation and the action history; the backend returns ONE structured {@code EngineAction}.
 *
 * <p>{@code observation} and {@code history} are kept as opaque {@link JsonNode} so the wire shape can
 * evolve on the device (new element attrs, action kinds) without breaking backend deserialization.
 */
public record NextActionRequest(
        PlatformId platform, String task, JsonNode observation, JsonNode history) {
}

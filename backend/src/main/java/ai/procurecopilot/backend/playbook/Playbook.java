package ai.procurecopilot.backend.playbook;

import ai.procurecopilot.backend.common.PlatformId;
import java.util.List;
import java.util.Map;

/**
 * A deterministic recorded flow for one platform (PROCURE_COPILOT_PLAN.md §3.5.7, Epic 3). Steps are
 * opaque selector instructions ({@code List<Map<String,Object>>}) so the registry stays agnostic to
 * the device's step schema and a selector fix can ship without a backend release. Newer {@code version}
 * wins on upsert (shadow-mode promotion). Platform serializes to its lowercase wire string.
 */
public record Playbook(
        PlatformId platform, String flow, int version, List<Map<String, Object>> steps) {

    public Playbook {
        if (platform == null) {
            throw new IllegalArgumentException("platform is required");
        }
        if (flow == null || flow.isBlank()) {
            throw new IllegalArgumentException("flow is required");
        }
        steps = steps == null ? List.of() : List.copyOf(steps);
    }
}

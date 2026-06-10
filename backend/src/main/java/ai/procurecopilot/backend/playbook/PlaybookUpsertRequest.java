package ai.procurecopilot.backend.playbook;

import java.util.List;
import java.util.Map;

/**
 * Upsert body for {@code POST /playbooks/{platform}} (PROCURE_COPILOT_PLAN.md §3.5.7). The platform
 * comes from the path; the body carries the flow, candidate version and opaque selector steps.
 */
public record PlaybookUpsertRequest(String flow, int version, List<Map<String, Object>> steps) {
}

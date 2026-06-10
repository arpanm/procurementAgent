package ai.procurecopilot.backend.telemetry;

import java.time.Instant;

/**
 * A tamper-evident audit record for a consequential action (PROCURE_COPILOT_PLAN.md §7, Epic 0/7) —
 * e.g. cart add, checkout, order placed. {@code beforeJson}/{@code afterJson} capture state around the
 * action and {@code screenshotRef} optionally points at a captured frame for eval/repro.
 */
public record AuditEvent(
        String actor,
        String action,
        String beforeJson,
        String afterJson,
        Instant at,
        String screenshotRef) {
}

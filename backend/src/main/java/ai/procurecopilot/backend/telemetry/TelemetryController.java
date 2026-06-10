package ai.procurecopilot.backend.telemetry;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Telemetry read endpoints (PROCURE_COPILOT_PLAN.md §5, Epic 7). Exposes the last N step-level traces
 * and audit events for the eval harness / ops dashboard. Read-only; ingestion happens in-process via
 * {@link TelemetryService}.
 */
@RestController
public class TelemetryController {

    private static final int DEFAULT_LIMIT = 100;

    private final TelemetryService telemetry;

    public TelemetryController(TelemetryService telemetry) {
        this.telemetry = telemetry;
    }

    @GetMapping("/telemetry/recent")
    public List<TraceSpan> recent(@RequestParam(name = "limit", defaultValue = "100") int limit) {
        return telemetry.recentTraces(limit <= 0 ? DEFAULT_LIMIT : limit);
    }

    @GetMapping("/telemetry/audit")
    public List<AuditEvent> audit(@RequestParam(name = "limit", defaultValue = "100") int limit) {
        return telemetry.recentAudits(limit <= 0 ? DEFAULT_LIMIT : limit);
    }
}

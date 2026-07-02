package ai.procurecopilot.backend.telemetry;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Lightweight, dependency-free telemetry sink (PROCURE_COPILOT_PLAN.md §5, Epic 0/7). Holds step-level
 * trace spans and audit events in bounded in-memory ring buffers so a long run can't exhaust memory.
 * Intentionally models the OTel/Langfuse trace shape ({@link TraceSpan}) so a real exporter can be
 * wired in later without touching call sites. Thread-safe via per-buffer locks.
 *
 * <p>The buffer sizes are configurable ({@code procure.telemetry.max-*}); when a buffer is full the
 * oldest entry is evicted and counted in {@link #getDroppedTraces()} / {@link #getDroppedAudits()} so the
 * truncation is observable rather than silent. For long-term retention wire an exporter (OTel/Langfuse)
 * at these call sites — this in-memory sink is for recent-history debugging only.
 */
@Service
public class TelemetryService {

    private final int maxTraces;
    private final int maxAudits;

    private final Deque<TraceSpan> traces = new ArrayDeque<>();
    private final Deque<AuditEvent> audits = new ArrayDeque<>();
    private final AtomicLong droppedTraces = new AtomicLong();
    private final AtomicLong droppedAudits = new AtomicLong();

    public TelemetryService(
            @Value("${procure.telemetry.max-traces:1000}") int maxTraces,
            @Value("${procure.telemetry.max-audits:1000}") int maxAudits) {
        this.maxTraces = maxTraces < 1 ? 1000 : maxTraces;
        this.maxAudits = maxAudits < 1 ? 1000 : maxAudits;
    }

    /** Record a step-level trace span. */
    public TraceSpan trace(
            String name, String task, String sessionId, Map<String, Object> attributes, Long durationMs) {
        Map<String, Object> attrs = attributes == null
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(attributes));
        TraceSpan span = new TraceSpan(name, task, sessionId, attrs, Instant.now(), durationMs);
        synchronized (traces) {
            traces.addLast(span);
            while (traces.size() > maxTraces) {
                traces.removeFirst();
                droppedTraces.incrementAndGet();
            }
        }
        return span;
    }

    /** Record a tamper-evident audit event for a consequential action (§7). */
    public AuditEvent audit(
            String actor, String action, String beforeJson, String afterJson, String screenshotRef) {
        AuditEvent event =
                new AuditEvent(actor, action, beforeJson, afterJson, Instant.now(), screenshotRef);
        synchronized (audits) {
            audits.addLast(event);
            while (audits.size() > maxAudits) {
                audits.removeFirst();
                droppedAudits.incrementAndGet();
            }
        }
        return event;
    }

    /** The most recent {@code limit} trace spans, newest last. */
    public List<TraceSpan> recentTraces(int limit) {
        synchronized (traces) {
            return tail(new ArrayList<>(traces), limit);
        }
    }

    /** The most recent {@code limit} audit events, newest last. */
    public List<AuditEvent> recentAudits(int limit) {
        synchronized (audits) {
            return tail(new ArrayList<>(audits), limit);
        }
    }

    /** Count of trace spans evicted by the ring buffer (so truncation is observable, not silent). */
    public long getDroppedTraces() {
        return droppedTraces.get();
    }

    /** Count of audit events evicted by the ring buffer. */
    public long getDroppedAudits() {
        return droppedAudits.get();
    }

    private static <T> List<T> tail(List<T> all, int limit) {
        if (limit <= 0 || limit >= all.size()) {
            return all;
        }
        return new ArrayList<>(all.subList(all.size() - limit, all.size()));
    }
}

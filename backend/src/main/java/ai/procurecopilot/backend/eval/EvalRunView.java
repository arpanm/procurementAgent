package ai.procurecopilot.backend.eval;

import java.time.Instant;

/** A read view of an {@link EvalRunEntity} for the eval observability API (omits the raw clobs). */
public record EvalRunView(
        Long id,
        String platform,
        EvalTrigger trigger,
        EvalStatus status,
        int failuresConsidered,
        Integer fromVersion,
        Integer toVersion,
        String summary,
        Instant startedAt,
        Instant finishedAt) {

    public static EvalRunView of(EvalRunEntity e) {
        return new EvalRunView(
                e.getId(), e.getPlatform(), e.getTrigger(), e.getStatus(),
                e.getFailuresConsidered(), e.getFromVersion(), e.getToVersion(),
                e.getSummary(), e.getStartedAt(), e.getFinishedAt());
    }
}

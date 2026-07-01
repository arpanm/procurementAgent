package ai.procurecopilot.backend.eval;

import ai.procurecopilot.backend.common.PlatformId;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

/**
 * Orchestrates the three guided-RAG eval triggers (PROCURE_COPILOT_PLAN.md guided-RAG layer):
 * <ul>
 *   <li><b>daily</b> — a once-a-day scheduled sweep over every platform;
 *   <li><b>manual</b> — an explicit operator-requested run;
 *   <li><b>repeating-failure</b> — fired when a freshly ingested failure has recurred enough to look
 *       systemic, but rate-limited to at most one such run per platform per {@link
 *       #REPEATING_EVAL_COOLDOWN} so a flapping device can't stampede the model.
 * </ul>
 * Ingest always persists the failure; the eval only piggybacks when the repeat + cooldown gates pass.
 */
@Service
public class EvalTriggerService {

    /** At most one repeating-failure eval per platform within this window. */
    static final Duration REPEATING_EVAL_COOLDOWN = Duration.ofHours(1);

    private static final Logger log = LoggerFactory.getLogger(EvalTriggerService.class);

    private final FailureLogService failures;
    private final RagEvalService eval;
    private final EvalRunRepository runs;
    private final Clock clock;

    public EvalTriggerService(
            FailureLogService failures,
            RagEvalService eval,
            EvalRunRepository runs,
            Clock clock) {
        this.failures = failures;
        this.eval = eval;
        this.runs = runs;
        this.clock = clock;
    }

    /** The outcome of ingesting a device failure report. */
    public record IngestResult(long failureId, boolean evalTriggered) {}

    /** Persist a device failure and, if it now looks systemic, fire a rate-limited eval. */
    public IngestResult ingest(PlatformId platform, FailureIngest ingest) {
        Instant now = clock.instant();
        FailureLogEntity saved = failures.record(platform, ingest, now);
        boolean triggered = false;
        if (failures.isRepeating(platform, saved.getSignature(), now)
                && !repeatingEvalRecently(platform, now)) {
            log.info("eval: repeating failure '{}' on {} — firing eval",
                    saved.getSignature(), platform.wire());
            eval.evaluate(platform, EvalTrigger.REPEATING_FAILURE, now);
            triggered = true;
        }
        return new IngestResult(saved.getId(), triggered);
    }

    /** Run an eval pass now for one platform (manual trigger). */
    public EvalRunEntity runManual(PlatformId platform) {
        return eval.evaluate(platform, EvalTrigger.MANUAL, clock.instant());
    }

    /** The once-a-day scheduled sweep over every platform. */
    @Scheduled(cron = "${procure.eval.daily-cron:0 0 3 * * *}")
    public void daily() {
        Instant now = clock.instant();
        for (PlatformId platform : PlatformId.values()) {
            try {
                eval.evaluate(platform, EvalTrigger.DAILY, now);
            } catch (RuntimeException e) {
                log.warn("eval: daily sweep failed for {}: {}", platform.wire(), e.getMessage());
            }
        }
    }

    private boolean repeatingEvalRecently(PlatformId platform, Instant now) {
        return runs.existsByPlatformAndTriggerAndStartedAtAfter(
                platform.wire(), EvalTrigger.REPEATING_FAILURE, now.minus(REPEATING_EVAL_COOLDOWN));
    }
}

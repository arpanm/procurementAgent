package ai.procurecopilot.backend.eval;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.data.domain.PageRequest;

/**
 * H2 persistence tests for the eval-observability repositories: failure-log querying (unconsumed
 * set, recent window, per-signature counts) plus eval-run and pending-patch lifecycle round-trips.
 */
@DataJpaTest
class EvalRepositoriesTest {

    @Autowired private FailureLogRepository failures;
    @Autowired private EvalRunRepository runs;
    @Autowired private PendingPatchRepository patches;

    private FailureLogEntity failure(String platform, String signature, Instant at) {
        return new FailureLogEntity(
                platform, "addToCart", signature, "not confirmed",
                "https://x/y", "url=… (3 elements)", null, signature, "Paneer", at);
    }

    @Test
    void unconsumedFailuresComeBackOldestFirstAndDropOnceConsumed() {
        Instant t0 = Instant.parse("2026-06-30T10:00:00Z");
        failures.save(failure("hyperpure", "SKU-1", t0));
        FailureLogEntity second = failures.save(failure("hyperpure", "SKU-2", t0.plusSeconds(60)));
        failures.save(failure("amazon", "SKU-3", t0)); // other platform — excluded

        List<FailureLogEntity> open =
                failures.findByPlatformAndConsumedFalseOrderByCreatedAtAsc("hyperpure");
        assertThat(open).extracting(FailureLogEntity::getSignature).containsExactly("SKU-1", "SKU-2");

        second.markConsumed();
        failures.save(second);

        assertThat(failures.findByPlatformAndConsumedFalseOrderByCreatedAtAsc("hyperpure"))
                .extracting(FailureLogEntity::getSignature)
                .containsExactly("SKU-1");
    }

    @Test
    void perSignatureCountRespectsPlatformAndWindow() {
        Instant now = Instant.parse("2026-06-30T12:00:00Z");
        failures.save(failure("hyperpure", "SKU-1", now.minus(90, ChronoUnit.MINUTES))); // too old
        failures.save(failure("hyperpure", "SKU-1", now.minus(30, ChronoUnit.MINUTES)));
        failures.save(failure("hyperpure", "SKU-1", now.minus(5, ChronoUnit.MINUTES)));
        failures.save(failure("hyperpure", "SKU-2", now.minus(5, ChronoUnit.MINUTES))); // other sig

        long recent = failures.countByPlatformAndSignatureAndCreatedAtAfter(
                "hyperpure", "SKU-1", now.minus(60, ChronoUnit.MINUTES));
        assertThat(recent).isEqualTo(2);
    }

    @Test
    void recentFailuresComeBackNewestFirstBounded() {
        Instant t0 = Instant.parse("2026-06-30T10:00:00Z");
        failures.save(failure("hyperpure", "OLD", t0));
        failures.save(failure("hyperpure", "MID", t0.plusSeconds(60)));
        failures.save(failure("hyperpure", "NEW", t0.plusSeconds(120)));

        List<FailureLogEntity> recent =
                failures.findByPlatformOrderByCreatedAtDesc("hyperpure", PageRequest.of(0, 2));
        assertThat(recent).extracting(FailureLogEntity::getSignature).containsExactly("NEW", "MID");
    }

    @Test
    void evalRunPersistsOutcomeAndComesBackNewestFirst() {
        Instant t0 = Instant.parse("2026-06-30T09:00:00Z");
        EvalRunEntity run = new EvalRunEntity("hyperpure", EvalTrigger.MANUAL, t0);
        run.setStatus(EvalStatus.SUCCESS);
        run.setFailuresConsidered(3);
        run.setVersions(2, 3);
        run.setSummary("added atcToken 'buy now'");
        run.finish(t0.plusSeconds(5));
        runs.save(run);
        runs.save(new EvalRunEntity("hyperpure", EvalTrigger.DAILY, t0.plusSeconds(600)));

        List<EvalRunEntity> history =
                runs.findByPlatformOrderByStartedAtDesc("hyperpure", PageRequest.of(0, 10));
        assertThat(history).hasSize(2);
        assertThat(history.get(0).getTrigger()).isEqualTo(EvalTrigger.DAILY);
        EvalRunEntity reloaded = history.get(1);
        assertThat(reloaded.getStatus()).isEqualTo(EvalStatus.SUCCESS);
        assertThat(reloaded.getFailuresConsidered()).isEqualTo(3);
        assertThat(reloaded.getToVersion()).isEqualTo(3);
        assertThat(reloaded.getSummary()).contains("buy now");
    }

    @Test
    void pendingPatchFiltersByStatusAndResolves() {
        Instant t0 = Instant.parse("2026-06-30T09:00:00Z");
        PendingPatchEntity p = patches.save(new PendingPatchEntity(
                "hyperpure", 1L, "token-removal", "drop stale reject token",
                "{\"op\":\"remove\"}", t0));
        patches.save(new PendingPatchEntity(
                "hyperpure", 1L, "policy-flip", "trustListingPrice -> false",
                "{\"op\":\"flip\"}", t0.plusSeconds(1)));

        assertThat(patches.findByPlatformAndStatusOrderByCreatedAtDesc("hyperpure", PatchStatus.PENDING))
                .hasSize(2);

        p.resolve(PatchStatus.PROMOTED, t0.plusSeconds(100));
        patches.save(p);

        assertThat(patches.findByPlatformAndStatusOrderByCreatedAtDesc("hyperpure", PatchStatus.PENDING))
                .extracting(PendingPatchEntity::getKind)
                .containsExactly("policy-flip");
        assertThat(patches.findByPlatformAndStatusOrderByCreatedAtDesc("hyperpure", PatchStatus.PROMOTED))
                .hasSize(1);
    }
}

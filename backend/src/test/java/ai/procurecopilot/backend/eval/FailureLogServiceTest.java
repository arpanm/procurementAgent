package ai.procurecopilot.backend.eval;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.PlatformId;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;

/** Persistence + repeat-detection behaviour of {@link FailureLogService} over a real H2 repo. */
@DataJpaTest
@Import(FailureLogService.class)
class FailureLogServiceTest {

    @Autowired private FailureLogService service;

    private static final Instant NOW = Instant.parse("2026-06-30T12:00:00Z");

    private FailureIngest ingest(String signature) {
        return new FailureIngest(
                "addToCart", signature, "not confirmed", "https://x/y",
                "url=… (3 elements)", null, signature, "Paneer 1kg", NOW.toString());
    }

    @Test
    void recordPersistsTheReportUnderItsPlatform() {
        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW);

        List<FailureLogEntity> open = service.unconsumed(PlatformId.HYPERPURE);
        assertThat(open).hasSize(1);
        FailureLogEntity e = open.get(0);
        assertThat(e.getSignature()).isEqualTo("SKU-1");
        assertThat(e.getFlow()).isEqualTo("addToCart");
        assertThat(e.getItemName()).isEqualTo("Paneer 1kg");
        assertThat(e.isConsumed()).isFalse();
    }

    @Test
    void singleFailureIsNotRepeatingButTheThresholdMakesItSo() {
        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW.minus(2, ChronoUnit.HOURS));
        assertThat(service.isRepeating(PlatformId.HYPERPURE, "SKU-1", NOW)).isFalse();

        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW.minus(1, ChronoUnit.HOURS));
        assertThat(service.isRepeating(PlatformId.HYPERPURE, "SKU-1", NOW)).isTrue();
    }

    @Test
    void occurrencesOutsideTheWindowDoNotCount() {
        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW.minus(30, ChronoUnit.HOURS));
        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW.minus(26, ChronoUnit.HOURS));
        assertThat(service.isRepeating(PlatformId.HYPERPURE, "SKU-1", NOW)).isFalse();
    }

    @Test
    void repeatCountIsScopedToPlatformAndSignature() {
        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW.minus(1, ChronoUnit.HOURS));
        service.record(PlatformId.AMAZON, ingest("SKU-1"), NOW.minus(1, ChronoUnit.HOURS));
        service.record(PlatformId.HYPERPURE, ingest("SKU-2"), NOW.minus(1, ChronoUnit.HOURS));
        assertThat(service.isRepeating(PlatformId.HYPERPURE, "SKU-1", NOW)).isFalse();
    }

    @Test
    void consumedFailuresDropOutOfTheUnconsumedSet() {
        service.record(PlatformId.HYPERPURE, ingest("SKU-1"), NOW);
        service.record(PlatformId.HYPERPURE, ingest("SKU-2"), NOW.plusSeconds(60));

        List<FailureLogEntity> open = service.unconsumed(PlatformId.HYPERPURE);
        assertThat(open).hasSize(2);
        service.markConsumed(open);

        assertThat(service.unconsumed(PlatformId.HYPERPURE)).isEmpty();
        assertThat(service.recent(PlatformId.HYPERPURE, 10)).hasSize(2);
    }

    @Test
    void signatureFallsBackToSkuThenSlug() {
        assertThat(service.signatureFor(new FailureIngest(
                        "addToCart", "  ", "r", null, null, null, "SKU-9", "Tomato", null)))
                .isEqualTo("SKU-9");
        assertThat(service.signatureFor(new FailureIngest(
                        "addToCart", null, "no ADD button", null, null, null, null, "Red Onion", null)))
                .isEqualTo("red-onion-no-add-button");
    }
}

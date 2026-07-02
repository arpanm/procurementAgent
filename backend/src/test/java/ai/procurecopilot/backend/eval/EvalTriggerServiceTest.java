package ai.procurecopilot.backend.eval;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.PlatformId;
import ai.procurecopilot.backend.knowledge.KnowledgeService;
import ai.procurecopilot.backend.llm.AnthropicProperties;
import ai.procurecopilot.backend.llm.ClaudeService;
import ai.procurecopilot.backend.llm.LlmProperties;
import ai.procurecopilot.backend.llm.OllamaClient;
import ai.procurecopilot.backend.llm.SecretScrubber;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * The three-trigger orchestration: single failures don't fire an eval, a recurring signature does,
 * and a second recurrence inside the cooldown does not re-fire. Plus the manual and daily paths.
 */
@DataJpaTest
@Import({JacksonAutoConfiguration.class, KnowledgeService.class, FailureLogService.class})
class EvalTriggerServiceTest {

    @Autowired private KnowledgeService knowledge;
    @Autowired private FailureLogService failures;
    @Autowired private EvalRunRepository runs;
    @Autowired private PendingPatchRepository pending;

    private static final Instant NOW = Instant.parse("2026-06-30T12:00:00Z");
    private final ObjectMapper mapper = new ObjectMapper();
    private EvalTriggerService triggers;

    @BeforeEach
    void setUp() {
        LlmProperties llm = new LlmProperties("anthropic", null);
        ClaudeService claude = new ClaudeService(
                new AnthropicProperties("http://localhost", "", "2023-06-01", "model", 2048, true),
                llm, new OllamaClient(llm, mapper, WebClient.builder()),
                new SecretScrubber(), mapper, List.of(new RagEvalResponder()), WebClient.builder());
        RagEvalService eval =
                new RagEvalService(claude, mapper, knowledge, failures, runs, pending);
        triggers = new EvalTriggerService(failures, eval, runs, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private FailureIngest ingest(String signature) {
        return new FailureIngest("addToCart", signature, "no ADD button", "https://hp/p/x",
                "url=… (3 elements)", null, signature, "Paneer 1kg", NOW.toString());
    }

    private long repeatingRunCount() {
        return runs.findByPlatformOrderByStartedAtDesc("hyperpure", PageRequest.of(0, 50)).stream()
                .filter(r -> r.getTrigger() == EvalTrigger.REPEATING_FAILURE)
                .count();
    }

    @Test
    void aSingleFailureDoesNotTriggerAnEval() {
        EvalTriggerService.IngestResult res = triggers.ingest(PlatformId.HYPERPURE, ingest("SKU-1"));
        assertThat(res.evalTriggered()).isFalse();
        assertThat(repeatingRunCount()).isZero();
    }

    @Test
    void aRecurringFailureTriggersExactlyOneEvalThenCoolsDown() {
        triggers.ingest(PlatformId.HYPERPURE, ingest("SKU-1"));
        EvalTriggerService.IngestResult second =
                triggers.ingest(PlatformId.HYPERPURE, ingest("SKU-1"));
        assertThat(second.evalTriggered()).isTrue();
        assertThat(repeatingRunCount()).isEqualTo(1);

        // Third recurrence within the cooldown hour must NOT fire another eval.
        EvalTriggerService.IngestResult third =
                triggers.ingest(PlatformId.HYPERPURE, ingest("SKU-1"));
        assertThat(third.evalTriggered()).isFalse();
        assertThat(repeatingRunCount()).isEqualTo(1);
    }

    @Test
    void manualRunRecordsAManualEval() {
        triggers.ingest(PlatformId.HYPERPURE, ingest("SKU-9"));
        EvalRunEntity run = triggers.runManual(PlatformId.HYPERPURE);
        assertThat(run.getTrigger()).isEqualTo(EvalTrigger.MANUAL);
        assertThat(run.getFinishedAt()).isNotNull();
    }

    @Test
    void dailySweepRecordsARunForEveryPlatform() {
        triggers.daily();
        assertThat(runs.findByPlatformOrderByStartedAtDesc("hyperpure", PageRequest.of(0, 10)))
                .anyMatch(r -> r.getTrigger() == EvalTrigger.DAILY);
        assertThat(runs.findByPlatformOrderByStartedAtDesc("amazon", PageRequest.of(0, 10)))
                .anyMatch(r -> r.getTrigger() == EvalTrigger.DAILY);
    }
}

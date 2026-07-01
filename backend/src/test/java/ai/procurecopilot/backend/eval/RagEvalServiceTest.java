package ai.procurecopilot.backend.eval;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.PlatformId;
import ai.procurecopilot.backend.knowledge.KnowledgeDoc;
import ai.procurecopilot.backend.knowledge.KnowledgeService;
import ai.procurecopilot.backend.llm.AnthropicProperties;
import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeResponder;
import ai.procurecopilot.backend.llm.ClaudeService;
import ai.procurecopilot.backend.llm.SecretScrubber;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Behaviour of the guided-RAG self-improvement engine over real H2 repos with a mocked Claude: the
 * hybrid-by-risk split (additions auto-applied, removals/flips gated), failure consumption, error
 * handling that preserves the batch, and the promote/reject lifecycle for gated patches.
 */
@DataJpaTest
@Import({JacksonAutoConfiguration.class, KnowledgeService.class, FailureLogService.class})
class RagEvalServiceTest {

    @Autowired private KnowledgeService knowledge;
    @Autowired private FailureLogService failures;
    @Autowired private EvalRunRepository runs;
    @Autowired private PendingPatchRepository pending;

    private final ObjectMapper mapper = new ObjectMapper();
    private final StubResponder responder = new StubResponder();
    private RagEvalService eval;

    private static final Instant NOW = Instant.parse("2026-06-30T12:00:00Z");

    /** A mutable stub responder for the "rag-eval" task: each test sets the JSON (or an error). */
    private static final class StubResponder implements ClaudeResponder {
        private String json = "{}";
        private RuntimeException error;

        @Override
        public String task() {
            return RagEvalService.TASK;
        }

        @Override
        public String respond(ClaudeRequest request) {
            if (error != null) {
                throw error;
            }
            return json;
        }
    }

    @BeforeEach
    void setUp() {
        ClaudeService claude = new ClaudeService(
                new AnthropicProperties("http://localhost", "", "2023-06-01", "model", 2048, true),
                new SecretScrubber(),
                mapper,
                List.of(responder),
                WebClient.builder());
        eval = new RagEvalService(claude, mapper, knowledge, failures, runs, pending);
    }

    private void seedFailure(String signature) {
        failures.record(PlatformId.HYPERPURE, new FailureIngest(
                "addToCart", signature, "no ADD button", "https://hp/p/x",
                "url=… (3 elements)", null, signature, "Paneer 1kg", NOW.toString()), NOW);
    }

    private void model(String json) {
        responder.json = json;
    }

    @Test
    void additionsAreAutoAppliedAndBumpTheVersion() {
        seedFailure("SKU-1");
        int before = knowledge.get(PlatformId.HYPERPURE).version();
        model("{\"summary\":\"add buy now\",\"additions\":{\"atcTokens\":[\"buy now\"],"
                + "\"addedTokens\":[\"in your bag\"]},\"removals\":{},\"policyFlips\":{}}");

        EvalRunEntity run = eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.MANUAL, NOW);

        assertThat(run.getStatus()).isEqualTo(EvalStatus.SUCCESS);
        assertThat(run.getFailuresConsidered()).isEqualTo(1);
        KnowledgeDoc doc = knowledge.get(PlatformId.HYPERPURE);
        assertThat(doc.version()).isEqualTo(before + 1);
        assertThat(doc.hints().atcTokens()).contains("buy now");
        assertThat(doc.hints().addedTokens()).contains("in your bag");
        assertThat(failures.unconsumed(PlatformId.HYPERPURE)).isEmpty();
        assertThat(pending.findByPlatformAndStatusOrderByCreatedAtDesc(
                "hyperpure", PatchStatus.PENDING)).isEmpty();
    }

    @Test
    void duplicateAdditionIsANoopAndDoesNotBumpVersion() {
        seedFailure("SKU-1");
        int before = knowledge.get(PlatformId.HYPERPURE).version();
        // "add" is already an atcToken in the hyperpure seed.
        model("{\"summary\":\"\",\"additions\":{\"atcTokens\":[\"add\"]},"
                + "\"removals\":{},\"policyFlips\":{}}");

        EvalRunEntity run = eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.DAILY, NOW);

        assertThat(run.getStatus()).isEqualTo(EvalStatus.NOOP);
        assertThat(knowledge.get(PlatformId.HYPERPURE).version()).isEqualTo(before);
    }

    @Test
    void removalsAndPolicyFlipsAreGatedNotApplied() {
        seedFailure("SKU-1");
        int before = knowledge.get(PlatformId.HYPERPURE).version();
        boolean trustBefore = knowledge.get(PlatformId.HYPERPURE).policies().trustListingPrice();
        model("{\"summary\":\"risky\",\"additions\":{},"
                + "\"removals\":{\"rejectTokens\":[\"sponsored\"]},"
                + "\"policyFlips\":{\"trustListingPrice\":false}}");

        EvalRunEntity run = eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.MANUAL, NOW);

        assertThat(run.getStatus()).isEqualTo(EvalStatus.SUCCESS);
        // Live doc untouched — gated changes never auto-apply.
        KnowledgeDoc doc = knowledge.get(PlatformId.HYPERPURE);
        assertThat(doc.version()).isEqualTo(before);
        assertThat(doc.policies().trustListingPrice()).isEqualTo(trustBefore);
        assertThat(doc.hints().rejectTokens()).contains("sponsored");

        List<PendingPatchEntity> gated = pending.findByPlatformAndStatusOrderByCreatedAtDesc(
                "hyperpure", PatchStatus.PENDING);
        assertThat(gated).extracting(PendingPatchEntity::getKind)
                .containsExactlyInAnyOrder("token-removal", "policy-flip");
        assertThat(gated).allSatisfy(p -> assertThat(p.getEvalRunId()).isEqualTo(run.getId()));
    }

    @Test
    void emptyBatchIsANoopWithoutCallingTheModel() {
        EvalRunEntity run = eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.DAILY, NOW);
        assertThat(run.getStatus()).isEqualTo(EvalStatus.NOOP);
        assertThat(run.getFailuresConsidered()).isZero();
    }

    @Test
    void modelFailurePreservesTheBatchForRetry() {
        seedFailure("SKU-1");
        responder.error = new RuntimeException("backend down");

        EvalRunEntity run = eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.MANUAL, NOW);

        assertThat(run.getStatus()).isEqualTo(EvalStatus.ERROR);
        assertThat(run.getError()).contains("backend down");
        // Not consumed → a later run can retry.
        assertThat(failures.unconsumed(PlatformId.HYPERPURE)).hasSize(1);
    }

    @Test
    void promoteAppliesAGatedPolicyFlipAndBumpsVersion() {
        seedFailure("SKU-1");
        model("{\"summary\":\"flip\",\"additions\":{},\"removals\":{},"
                + "\"policyFlips\":{\"trustListingPrice\":false}}");
        eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.MANUAL, NOW);

        PendingPatchEntity flip = pending.findByPlatformAndStatusOrderByCreatedAtDesc(
                "hyperpure", PatchStatus.PENDING).get(0);
        int before = knowledge.get(PlatformId.HYPERPURE).version();

        KnowledgeDoc after = eval.promote(flip.getId(), NOW.plusSeconds(10));

        assertThat(after.policies().trustListingPrice()).isFalse();
        assertThat(after.version()).isEqualTo(before + 1);
        assertThat(pending.findById(flip.getId()).orElseThrow().getStatus())
                .isEqualTo(PatchStatus.PROMOTED);
    }

    @Test
    void rejectLeavesTheLiveDocUntouched() {
        seedFailure("SKU-1");
        model("{\"summary\":\"rm\",\"additions\":{},"
                + "\"removals\":{\"rejectTokens\":[\"sponsored\"]},\"policyFlips\":{}}");
        eval.evaluate(PlatformId.HYPERPURE, EvalTrigger.MANUAL, NOW);

        PendingPatchEntity rm = pending.findByPlatformAndStatusOrderByCreatedAtDesc(
                "hyperpure", PatchStatus.PENDING).get(0);
        int before = knowledge.get(PlatformId.HYPERPURE).version();

        eval.reject(rm.getId(), NOW.plusSeconds(10));

        assertThat(knowledge.get(PlatformId.HYPERPURE).hints().rejectTokens()).contains("sponsored");
        assertThat(knowledge.get(PlatformId.HYPERPURE).version()).isEqualTo(before);
        assertThat(pending.findById(rm.getId()).orElseThrow().getStatus())
                .isEqualTo(PatchStatus.REJECTED);
    }
}

package ai.procurecopilot.backend.agent;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.llm.AnthropicProperties;
import ai.procurecopilot.backend.llm.ClaudeService;
import ai.procurecopilot.backend.llm.SecretScrubber;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Slot-parser acceptance tests (PROCURE_COPILOT_PLAN.md Epic 1, §9.1): vernacular numerals, units,
 * synonyms across Hindi/Bengali/English, plus the low-confidence Claude fallback path.
 */
class IntentServiceTest {

    /** Rule parser needs no LLM, so it can be exercised with null collaborators. */
    private final IntentService ruleOnly = new IntentService(null, null);

    private Domain.RequestedItem find(IntentService.IntentResult r, String canonicalId) {
        Optional<Domain.RequestedItem> hit =
                r.items().stream().filter(i -> i.canonicalItemId().equals(canonicalId)).findFirst();
        assertThat(hit).as("expected item %s in %s", canonicalId, r.items()).isPresent();
        return hit.get();
    }

    private void assertItem(IntentService.IntentResult r, String canonicalId, int qty, String unit) {
        Domain.RequestedItem it = find(r, canonicalId);
        assertThat(it.qty()).as("qty of %s", canonicalId).isEqualTo(qty);
        assertThat(it.unit()).as("unit of %s", canonicalId).isEqualTo(unit);
    }

    @Test
    void canonicalAcceptanceUtterances() {
        IntentService.IntentResult a = ruleOnly.ruleParse("5 kilo aloo aur 2 carton tel");
        assertThat(a.items()).hasSize(2);
        assertItem(a, "potato", 5, "kg");
        assertItem(a, "oil", 2, "carton");

        IntentService.IntentResult b = ruleOnly.ruleParse("teen packet doodh");
        assertThat(b.items()).hasSize(1);
        assertItem(b, "milk", 3, "packet");
    }

    @Test
    void variedUtterances_qtyUnitAndCanonicalName() {
        assertItem(ruleOnly.ruleParse("do kilo pyaaz"), "onion", 2, "kg");
        assertItem(ruleOnly.ruleParse("10 kg chawal"), "rice", 10, "kg");
        assertItem(ruleOnly.ruleParse("paanch litre tel"), "oil", 5, "l");
        assertItem(ruleOnly.ruleParse("ek dozen anda"), "egg", 1, "dozen");
        assertItem(ruleOnly.ruleParse("2 packet paneer"), "paneer", 2, "packet");
        assertItem(ruleOnly.ruleParse("das kilo atta"), "flour", 10, "kg");
        assertItem(ruleOnly.ruleParse("char kg cheeni"), "sugar", 4, "kg");
        assertItem(ruleOnly.ruleParse("500 gram adrak"), "ginger", 500, "g");
        assertItem(ruleOnly.ruleParse("saat piece nimbu"), "lemon", 7, "piece");
        assertItem(ruleOnly.ruleParse("tin kg tamatar"), "tomato", 3, "kg");
        assertItem(ruleOnly.ruleParse("1 kg lehsun"), "garlic", 1, "kg");
        assertItem(ruleOnly.ruleParse("ek packet namak"), "salt", 1, "packet");
    }

    @Test
    void brandedOrder_extractsBrandVariantPackSizeAndCount() {
        IntentService.IntentResult r = ruleOnly.ruleParse(
                "order 1kg india gate basmati rice 5 packets and tata lite salt 1 kg 3 packets");
        assertThat(r.items()).hasSize(2);

        Domain.RequestedItem rice = find(r, "rice");
        assertThat(rice.name()).isEqualToIgnoringCase("rice");
        assertThat(rice.brand()).isEqualTo("India Gate");
        assertThat(rice.variant()).isEqualTo("basmati");
        assertThat(rice.packSize()).isEqualTo("1 kg");
        assertThat(rice.qty()).isEqualTo(5);
        assertThat(rice.unit()).isEqualTo("packet");

        Domain.RequestedItem salt = find(r, "salt");
        assertThat(salt.name()).isEqualToIgnoringCase("salt");
        assertThat(salt.brand()).isEqualTo("Tata");
        assertThat(salt.variant()).isEqualTo("lite");
        assertThat(salt.packSize()).isEqualTo("1 kg");
        assertThat(salt.qty()).isEqualTo(3);
        assertThat(salt.unit()).isEqualTo("packet");
    }

    @Test
    void multiWordItem_springOnion_isDistinctFromOnion() {
        IntentService.IntentResult r =
                ruleOnly.ruleParse("10kg spring onions, 5 amul paneer 1kg packets");
        assertThat(r.items()).hasSize(2);

        Domain.RequestedItem springOnion = find(r, "springonion");
        assertThat(springOnion.name()).isEqualToIgnoringCase("spring onion");
        assertThat(springOnion.qty()).isEqualTo(10);
        assertThat(springOnion.unit()).isEqualTo("kg");
        assertThat(springOnion.brand()).as("'spring' must not become a brand").isNull();
        assertThat(springOnion.variant()).isNull();

        Domain.RequestedItem paneer = find(r, "paneer");
        assertThat(paneer.brand()).isEqualTo("Amul");
        assertThat(paneer.qty()).isEqualTo(5);
        assertThat(paneer.unit()).isEqualTo("packet");
        assertThat(paneer.packSize()).isEqualTo("1 kg");
    }

    @Test
    void multiWordItems_areNotCollapsedOntoSingleToken() {
        assertThat(find(ruleOnly.ruleParse("1 kg green chilli"), "greenchilli").name())
                .isEqualToIgnoringCase("green chilli");
        assertThat(find(ruleOnly.ruleParse("200 g black pepper"), "blackpepper").name())
                .isEqualToIgnoringCase("black pepper");
        // The single-token item still resolves on its own.
        assertItem(ruleOnly.ruleParse("2 kg onion"), "onion", 2, "kg");
    }

    @Test
    void looseMeasure_keepsQtyUnitAndLeavesPackSizeNull() {
        Domain.RequestedItem potato = find(ruleOnly.ruleParse("2 kg potato"), "potato");
        assertThat(potato.qty()).isEqualTo(2);
        assertThat(potato.unit()).isEqualTo("kg");
        assertThat(potato.packSize()).isNull();
        assertThat(potato.brand()).isNull();
        assertThat(potato.variant()).isNull();
    }

    @Test
    void brandedItemWithBareWeight_treatsWeightAsPackSizeNotQuantity() {
        // "milky mist paneer 500 g" must NOT become qty=500 g — the weight is the pack size, qty=1.
        Domain.RequestedItem paneer = find(ruleOnly.ruleParse("milky mist paneer 500 g"), "paneer");
        assertThat(paneer.brand()).isEqualTo("Milky Mist");
        assertThat(paneer.qty()).isEqualTo(1);
        assertThat(paneer.unit()).isEqualTo("packet");
        assertThat(paneer.packSize()).isEqualTo("500 g");
    }

    @Test
    void unknownLeadingBrand_isCapturedByHeuristic() {
        Domain.RequestedItem rice = find(ruleOnly.ruleParse("1 kg kanaka rice 2 packets"), "rice");
        assertThat(rice.brand()).isEqualTo("Kanaka");
        assertThat(rice.qty()).isEqualTo(2);
        assertThat(rice.unit()).isEqualTo("packet");
        assertThat(rice.packSize()).isEqualTo("1 kg");
    }

    @Test
    void multiItemUtterance_splitsOnAur() {
        IntentService.IntentResult r =
                ruleOnly.ruleParse("do kilo aloo aur teen kilo pyaz aur ek packet namak");
        assertThat(r.items()).hasSize(3);
        assertItem(r, "potato", 2, "kg");
        assertItem(r, "onion", 3, "kg");
        assertItem(r, "salt", 1, "packet");
    }

    @Test
    void bengaliAndDevanagariNumerals() {
        // Bengali ৫ and Devanagari ५ both mean 5.
        assertItem(ruleOnly.ruleParse("\u09EB kg aloo"), "potato", 5, "kg");
        assertItem(ruleOnly.ruleParse("\u096B kg chawal"), "rice", 5, "kg");
    }

    @Test
    void englishUtterances() {
        assertItem(ruleOnly.ruleParse("3 packet milk"), "milk", 3, "packet");
        assertItem(ruleOnly.ruleParse("2 kg potato"), "potato", 2, "kg");
    }

    @Test
    void knownUtterancesAreHighConfidence() {
        assertThat(ruleOnly.ruleParse("5 kilo aloo aur 2 carton tel").confidence())
                .isGreaterThanOrEqualTo(IntentService.FALLBACK_THRESHOLD);
        assertThat(ruleOnly.ruleParse("teen packet doodh").confidence())
                .isGreaterThanOrEqualTo(IntentService.FALLBACK_THRESHOLD);
    }

    @Test
    void gibberishIsLowConfidence() {
        assertThat(ruleOnly.ruleParse("xyzzy qwerty").confidence())
                .isLessThan(IntentService.FALLBACK_THRESHOLD);
        assertThat(ruleOnly.ruleParse("").confidence()).isZero();
    }

    @Test
    void canonicalItemIdIsNormalizedEnglishName() {
        Domain.RequestedItem it = find(ruleOnly.ruleParse("5 kilo aloo"), "potato");
        assertThat(it.canonicalItemId()).isEqualTo("potato");
        assertThat(it.canonicalItemId()).doesNotContain(" ");
        assertThat(it.canonicalItemId()).isEqualTo(it.canonicalItemId().toLowerCase());
    }

    @Test
    void lowConfidence_fallsBackToClaudeStub() {
        IntentService service = new IntentService(stubClaude(), new ObjectMapper());
        // Gibberish drives rule confidence below threshold, so the deterministic "intent" stub runs.
        IntentService.IntentResult r = service.parse("zzz qqq", "hi-IN");
        assertThat(r.items()).hasSize(1);
        assertThat(r.items().get(0).canonicalItemId()).isEqualTo("unknown");
        assertThat(r.confidence()).isEqualTo(0.5);
    }

    @Test
    void highConfidence_doesNotInvokeFallback() {
        // Null Claude would NPE if the fallback were taken; a confident parse must avoid it.
        IntentService.IntentResult r = ruleOnly.parse("5 kilo aloo aur 2 carton tel", "hi-IN");
        assertThat(r.items()).hasSize(2);
    }

    private static ClaudeService stubClaude() {
        AnthropicProperties props =
                new AnthropicProperties("http://localhost", "", "2023-06-01", "model", 2048, true);
        return new ClaudeService(
                props,
                new SecretScrubber(),
                new ObjectMapper(),
                List.of(new IntentResponder()),
                WebClient.builder());
    }
}

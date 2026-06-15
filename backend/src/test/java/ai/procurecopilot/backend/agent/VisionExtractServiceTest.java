package ai.procurecopilot.backend.agent;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.common.PlatformId;
import ai.procurecopilot.backend.llm.AnthropicProperties;
import ai.procurecopilot.backend.llm.ClaudeService;
import ai.procurecopilot.backend.llm.SecretScrubber;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Vision-extract tests (PROCURE_COPILOT_PLAN.md §3.5): the deterministic stub echoes the requested
 * item as a sample priced product, and parsing degrades safely to {@code not found} on bad output or
 * a missing/zero price (so the device never sources an invented price).
 */
class VisionExtractServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final VisionExtractService service = new VisionExtractService(stubClaude(), mapper);

    private static Domain.RequestedItem rice() {
        return new Domain.RequestedItem("rice", "basmati rice", 1, "kg", "India Gate", "basmati", "5 kg");
    }

    @Test
    void stubReturnsAFoundPricedProductForTheItem() {
        VisionExtractResponse res = service.extract(
                new VisionExtractRequest(PlatformId.HYPERPURE, rice(), "ZmFrZQ==", "image/png"));
        assertThat(res.found()).isTrue();
        assertThat(res.pricePaise()).isEqualTo(50000L);
        assertThat(res.inStock()).isTrue();
        assertThat(res.title().toLowerCase()).contains("basmati");
        assertThat(res.skuId()).isNotBlank();
        // The stub now echoes a ranked candidate list; the scalar fields mirror the first candidate.
        assertThat(res.candidates()).isNotEmpty();
        assertThat(res.candidates().get(0).title()).isEqualTo(res.title());
        assertThat(res.candidates().get(0).pricePaise()).isEqualTo(res.pricePaise());
    }

    @Test
    void parseReadsRankedCandidateArray() {
        VisionExtractResponse r = service.parse(
                "{\"found\":true,\"candidates\":["
                        + "{\"title\":\"Milky Mist Paneer 1 Kg\",\"pricePaise\":42000,\"inStock\":true},"
                        + "{\"title\":\"Milky Mist Paneer 500 g\",\"pricePaise\":23700,\"mrpPaise\":25000,"
                        + "\"inStock\":true},"
                        + "{\"title\":\"Amul Paneer 500 g\",\"pricePaise\":21000,\"inStock\":false}]}");
        assertThat(r.found()).isTrue();
        assertThat(r.candidates()).hasSize(3);
        // Scalar fields mirror the top (first) candidate.
        assertThat(r.title()).isEqualTo("Milky Mist Paneer 1 Kg");
        assertThat(r.pricePaise()).isEqualTo(42000L);
        assertThat(r.candidates().get(2).inStock()).isFalse();
        assertThat(r.candidates().get(1).mrpPaise()).isEqualTo(25000L);
    }

    @Test
    void parseDropsBadCandidatesAndDedupesSkus() {
        VisionExtractResponse r = service.parse(
                "{\"found\":true,\"candidates\":["
                        + "{\"title\":\"Onion 10 Kg\",\"pricePaise\":0},"
                        + "{\"title\":\"\",\"pricePaise\":5000},"
                        + "{\"title\":\"Onion 5 Kg\",\"pricePaise\":30000},"
                        + "{\"title\":\"Onion 5 Kg\",\"pricePaise\":31000}]}");
        assertThat(r.found()).isTrue();
        // Zero-price + empty-title dropped; the duplicate "Onion 5 Kg" SKU collapses to one.
        assertThat(r.candidates()).hasSize(1);
        assertThat(r.candidates().get(0).title()).isEqualTo("Onion 5 Kg");
        assertThat(r.candidates().get(0).pricePaise()).isEqualTo(30000L);
    }

    @Test
    void missingImageIsNotFound() {
        assertThat(service.extract(
                new VisionExtractRequest(PlatformId.HYPERPURE, rice(), "  ", "image/png")).found())
                .isFalse();
        assertThat(service.extract(
                new VisionExtractRequest(PlatformId.HYPERPURE, rice(), null, "image/png")).found())
                .isFalse();
    }

    @Test
    void parseDegradesToNotFoundOnBadOutput() {
        assertThat(service.parse("totally not json").found()).isFalse();
        assertThat(service.parse("{\"found\":false}").found()).isFalse();
        assertThat(service.parse("").found()).isFalse();
        // Found but no usable price -> not found (never invent a price).
        assertThat(service.parse("{\"found\":true,\"title\":\"X\"}").found()).isFalse();
        assertThat(service.parse("{\"found\":true,\"title\":\"X\",\"pricePaise\":0}").found()).isFalse();
    }

    @Test
    void parseReadsTitlePriceMrpStock() {
        VisionExtractResponse r = service.parse(
                "Here: {\"found\":true,\"title\":\"Daawat Basmati 5 Kg\",\"pricePaise\":65800,"
                        + "\"mrpPaise\":70000,\"inStock\":true} done");
        assertThat(r.found()).isTrue();
        assertThat(r.title()).isEqualTo("Daawat Basmati 5 Kg");
        assertThat(r.pricePaise()).isEqualTo(65800L);
        assertThat(r.mrpPaise()).isEqualTo(70000L);
        assertThat(r.skuId()).isEqualTo("daawat-basmati-5-kg");
    }

    private static ClaudeService stubClaude() {
        AnthropicProperties props =
                new AnthropicProperties("http://localhost", "", "2023-06-01", "model", 2048, true);
        return new ClaudeService(
                props,
                new SecretScrubber(),
                new ObjectMapper(),
                List.of(new VisionExtractResponder()),
                WebClient.builder());
    }
}

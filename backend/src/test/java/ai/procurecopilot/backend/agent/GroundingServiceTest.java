package ai.procurecopilot.backend.agent;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.PlatformId;
import ai.procurecopilot.backend.llm.AnthropicProperties;
import ai.procurecopilot.backend.llm.ClaudeService;
import ai.procurecopilot.backend.llm.LlmProperties;
import ai.procurecopilot.backend.llm.OllamaClient;
import ai.procurecopilot.backend.llm.SecretScrubber;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Grounding tests (PROCURE_COPILOT_PLAN.md §3.5, Epic 6): the deterministic "next-action" stub returns
 * a sensible action for the observation, and parsing degrades safely to {@code fail} on bad output.
 */
class GroundingServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final GroundingService grounding = new GroundingService(stubClaude(), mapper);

    private JsonNode obs(String elementsJson) throws Exception {
        return mapper.readTree(
                "{\"url\":\"https://hyperpure.com\",\"title\":\"Hyperpure\","
                        + "\"scroll\":{\"y\":0,\"h\":2000,\"vh\":800},\"elements\":" + elementsJson + "}");
    }

    @Test
    void searchTaskTypesIntoSearchbox() throws Exception {
        JsonNode observation = obs(
                "[{\"idx\":3,\"tag\":\"input\",\"role\":\"searchbox\",\"name\":\"Search for products\","
                        + "\"value\":null,\"bbox\":[0,0,10,10],\"attrs\":{\"type\":\"search\"}}]");
        JsonNode action = grounding.nextAction(
                new NextActionRequest(PlatformId.HYPERPURE, "search onions", observation, null));
        assertThat(action.path("type").asText()).isEqualTo("type");
        assertThat(action.path("idx").asInt()).isEqualTo(3);
        assertThat(action.path("value").asText()).contains("onions");
    }

    @Test
    void addToCartButtonIsClicked() throws Exception {
        JsonNode observation = obs(
                "[{\"idx\":7,\"tag\":\"button\",\"role\":null,\"name\":\"Add to cart\","
                        + "\"value\":null,\"bbox\":[0,0,10,10],\"attrs\":{}}]");
        JsonNode action = grounding.nextAction(
                new NextActionRequest(PlatformId.HYPERPURE, "add onions to cart", observation, null));
        assertThat(action.path("type").asText()).isEqualTo("click");
        assertThat(action.path("idx").asInt()).isEqualTo(7);
    }

    @Test
    void noActionableElementFails() throws Exception {
        JsonNode observation = obs("[]");
        JsonNode action = grounding.nextAction(
                new NextActionRequest(PlatformId.AMAZON, "checkout", observation, null));
        assertThat(action.path("type").asText()).isEqualTo("fail");
    }

    @Test
    void malformedCompletionDegradesToFail() {
        assertThat(grounding.parseAction("totally not json").path("type").asText()).isEqualTo("fail");
        assertThat(grounding.parseAction("{\"foo\":1}").path("type").asText()).isEqualTo("fail");
        assertThat(grounding.parseAction("{\"type\":\"banana\"}").path("type").asText())
                .isEqualTo("fail");
        assertThat(grounding.parseAction("").path("type").asText()).isEqualTo("fail");
    }

    @Test
    void prefixedCompletionIsStillParsed() {
        JsonNode action = grounding.parseAction("Here is the action: {\"type\":\"done\"} thanks");
        assertThat(action.path("type").asText()).isEqualTo("done");
    }

    private static ClaudeService stubClaude() {
        AnthropicProperties props =
                new AnthropicProperties("http://localhost", "", "2023-06-01", "model", 2048, true);
        LlmProperties llm = new LlmProperties("anthropic", null);
        return new ClaudeService(
                props,
                llm,
                new OllamaClient(llm, new ObjectMapper(), WebClient.builder()),
                new SecretScrubber(),
                new ObjectMapper(),
                List.of(new NextActionResponder()),
                WebClient.builder());
    }
}

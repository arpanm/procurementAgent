package ai.procurecopilot.backend.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Free/local LLM client backed by a running <b>Ollama</b> server ({@code /api/chat}). Used instead of
 * Anthropic when {@code llm.provider=ollama}. Supports text and vision (base64 screenshot → the
 * message's {@code images} array), so the guided price-read works with a local vision model
 * (e.g. {@code qwen2.5vl}). No API key, no network egress — everything stays on the machine.
 *
 * <p>The prompts throughout the app ask for strict JSON; a local 7B model is generally good at this but
 * less reliable than Claude, so all downstream parsers already degrade defensively on a bad completion.
 */
@Component
public class OllamaClient {

    private static final Logger log = LoggerFactory.getLogger(OllamaClient.class);

    private final LlmProperties props;
    private final ObjectMapper mapper;
    private final WebClient webClient;

    public OllamaClient(LlmProperties props, ObjectMapper mapper, WebClient.Builder webClientBuilder) {
        this.props = props;
        this.mapper = mapper;
        // 8 MB buffer: a vision completion + our own request echo can exceed the 256 KB default.
        this.webClient = webClientBuilder
                .baseUrl(props.ollamaOrDefault().baseUrlOrDefault())
                .codecs(c -> c.defaultCodecs().maxInMemorySize(8 * 1024 * 1024))
                .build();
    }

    /** Run one completion against Ollama and return the assistant's text. */
    public String complete(ClaudeRequest request) {
        boolean hasImage = request.hasImage();
        String model = hasImage
                ? props.ollamaOrDefault().visionModelOrDefault()
                : props.ollamaOrDefault().modelOrDefault();

        List<Map<String, Object>> messages = new ArrayList<>();
        if (request.system() != null && !request.system().isBlank()) {
            messages.add(Map.of("role", "system", "content", request.system()));
        }
        Map<String, Object> user = new LinkedHashMap<>();
        user.put("role", "user");
        user.put("content", request.user() == null ? "" : request.user());
        if (hasImage) {
            // Ollama takes raw base64 (no data: prefix) in the message's images array.
            user.put("images", List.of(request.imageBase64()));
        }
        messages.add(user);

        Map<String, Object> options = new LinkedHashMap<>();
        options.put("temperature", 0);
        if (request.maxTokens() != null) {
            options.put("num_predict", request.maxTokens());
        }

        Map<String, Object> body = Map.of(
                "model", model,
                "messages", messages,
                "stream", false,
                "options", options);

        try {
            String raw = webClient.post()
                    .uri("/api/chat")
                    .header("content-type", "application/json")
                    .bodyValue(body)
                    .retrieve()
                    .bodyToMono(String.class)
                    .timeout(Duration.ofSeconds(180))
                    .block();
            return extractText(raw);
        } catch (RuntimeException e) {
            log.error("Ollama call failed for task {} (model {}): {}",
                    request.task(), model, e.getMessage());
            throw new ClaudeService.ClaudeException(
                    "Ollama call failed for task " + request.task()
                            + " — is `ollama serve` running and is model '" + model + "' pulled?",
                    e);
        }
    }

    private String extractText(String raw) {
        try {
            JsonNode root = mapper.readTree(raw);
            // Non-streamed /api/chat returns { "message": { "role": "...", "content": "..." }, ... }
            String content = root.path("message").path("content").asText("");
            if (content.isEmpty()) {
                content = root.path("response").asText(""); // /api/generate fallback shape
            }
            return content;
        } catch (Exception e) {
            throw new ClaudeService.ClaudeException("Could not parse Ollama response", e);
        }
    }
}

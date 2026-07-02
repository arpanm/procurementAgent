package ai.procurecopilot.backend.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

/**
 * The single entry point for all Anthropic reasoning (PROCURE_COPILOT_PLAN.md §3.2). Every payload
 * is secret-scrubbed before leaving the process. In stub mode (default for local/CI, or whenever no
 * key is present) it dispatches to a deterministic {@link ClaudeResponder} per task so the whole
 * agent loop is runnable offline.
 */
@Service
public class ClaudeService {

    private static final Logger log = LoggerFactory.getLogger(ClaudeService.class);

    private final AnthropicProperties props;
    private final LlmProperties llm;
    private final OllamaClient ollama;
    private final SecretScrubber scrubber;
    private final ObjectMapper mapper;
    private final Map<String, ClaudeResponder> responders;
    private final WebClient webClient;

    public ClaudeService(
            AnthropicProperties props,
            LlmProperties llm,
            OllamaClient ollama,
            SecretScrubber scrubber,
            ObjectMapper mapper,
            List<ClaudeResponder> stubResponders,
            WebClient.Builder webClientBuilder) {
        this.props = props;
        this.llm = llm;
        this.ollama = ollama;
        this.scrubber = scrubber;
        this.mapper = mapper;
        this.responders = stubResponders.stream()
                .collect(java.util.stream.Collectors.toMap(ClaudeResponder::task, r -> r, (a, b) -> a));
        this.webClient = webClientBuilder.baseUrl(props.baseUrl()).build();
    }

    /** Run one reasoning call and return the model's text completion. */
    public String complete(ClaudeRequest request) {
        ClaudeRequest scrubbed = new ClaudeRequest(
                request.task(),
                scrubber.scrub(request.system()),
                scrubber.scrub(request.user()),
                request.maxTokens(),
                request.imageBase64(),
                request.imageMediaType());

        if (isStub()) {
            ClaudeResponder responder = responders.get(scrubbed.task());
            if (responder != null) {
                return responder.respond(scrubbed);
            }
            log.debug("No stub responder for task '{}', returning empty object", scrubbed.task());
            return "{}";
        }
        // Free/local path: talk to Ollama instead of Anthropic when selected.
        if (llm.isOllama()) {
            return ollama.complete(scrubbed);
        }
        return callApi(scrubbed);
    }

    private String callApi(ClaudeRequest request) {
        int maxTokens = request.maxTokens() != null ? request.maxTokens() : props.maxTokensOrDefault();
        Map<String, Object> body = Map.of(
                "model", props.model(),
                "max_tokens", maxTokens,
                "system", request.system() == null ? "" : request.system(),
                "messages", List.of(Map.of("role", "user", "content", userContent(request))));
        try {
            String raw = webClient.post()
                    .uri("/v1/messages")
                    .header("x-api-key", props.apiKey())
                    .header("anthropic-version", props.version())
                    .header("content-type", "application/json")
                    .bodyValue(body)
                    .retrieve()
                    .bodyToMono(String.class)
                    .timeout(Duration.ofSeconds(60))
                    .block();
            return extractText(raw);
        } catch (WebClientResponseException e) {
            // Make config/quota failures self-explanatory in the log instead of a bare stack trace: a 404
            // here means the configured model id is retired/unavailable for this key — the exact outage
            // that surfaced in-app as "could not source / nothing found" with no obvious cause.
            String hint = switch (e.getStatusCode().value()) {
                case 404 -> " — model '" + props.model()
                        + "' not found for this API key; update ANTHROPIC_MODEL to a current model";
                case 401, 403 -> " — API key rejected; check ANTHROPIC_API_KEY";
                case 429 -> " — rate limited / quota exhausted; retry later or check billing";
                default -> "";
            };
            // Scrub + truncate the error body before logging: an upstream error may echo back part of the
            // request payload, so run it through the same SecretScrubber and bound its length.
            String body404 = scrubber.scrub(e.getResponseBodyAsString());
            if (body404 != null && body404.length() > 500) {
                body404 = body404.substring(0, 500) + "…";
            }
            log.error("Anthropic {} for task {}{} · body={}",
                    e.getStatusCode(), request.task(), hint, body404);
            throw new ClaudeException(
                    "Anthropic " + e.getStatusCode() + " for task " + request.task() + hint, e);
        } catch (Exception e) {
            throw new ClaudeException("Anthropic call failed for task " + request.task(), e);
        }
    }

    /**
     * The Anthropic message {@code content}: a plain string for text-only calls, or an
     * [image, text] block array when the request carries a screenshot (multimodal vision-extract).
     */
    private Object userContent(ClaudeRequest request) {
        String text = request.user() == null ? "" : request.user();
        if (!request.hasImage()) {
            return text;
        }
        String mediaType = request.imageMediaType() == null ? "image/png" : request.imageMediaType();
        Map<String, Object> image = Map.of(
                "type", "image",
                "source", Map.of(
                        "type", "base64",
                        "media_type", mediaType,
                        "data", request.imageBase64()));
        return List.of(image, Map.of("type", "text", "text", text));
    }

    private String extractText(String raw) {
        try {
            JsonNode root = mapper.readTree(raw);
            JsonNode content = root.path("content");
            if (content.isArray() && !content.isEmpty()) {
                return content.get(0).path("text").asText("");
            }
            return "";
        } catch (Exception e) {
            throw new ClaudeException("Could not parse Anthropic response", e);
        }
    }

    public boolean isStub() {
        return props.isStub();
    }

    /** Thrown when a live Anthropic call or its parsing fails. */
    public static class ClaudeException extends RuntimeException {
        public ClaudeException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}

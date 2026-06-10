package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * DOM grounding (PROCURE_COPILOT_PLAN.md §3.5, §3.6.3). Wraps a Claude "next-action" call: serialize
 * the observation into the prompt, ask for ONE action, and parse the model's JSON defensively into a
 * single valid {@code EngineAction}. Any malformed/unknown output degrades to a {@code fail} action so
 * the device loop never crashes on a bad completion.
 */
@Service
public class GroundingService {

    private static final String SYSTEM = """
            You are the DOM-grounding step of a web automation agent. You are given a task and a
            serialized observation of the interactable elements on the current page (each with an
            integer idx). Reply with EXACTLY ONE action as a single JSON object, no prose. Allowed:
            {"type":"click","idx":N}, {"type":"type","idx":N,"value":"..."},
            {"type":"select","idx":N,"value":"..."}, {"type":"scroll","dy":N},
            {"type":"navigate","url":"..."}, {"type":"extract","data":{...}},
            {"type":"needs_human","kind":"otp|payment","prompt":"..."}, {"type":"done"},
            {"type":"fail","reason":"..."}. Never automate OTP or payment entry.""";

    private static final Set<String> VALID_TYPES = Set.of(
            "click", "type", "select", "scroll", "navigate", "extract", "needs_human", "done", "fail");

    private final ClaudeService claude;
    private final ObjectMapper mapper;

    public GroundingService(ClaudeService claude, ObjectMapper mapper) {
        this.claude = claude;
        this.mapper = mapper;
    }

    /** Decide the next single action for the given observation/task. Never returns null. */
    public JsonNode nextAction(NextActionRequest request) {
        if (request == null) {
            return fail("empty request");
        }
        String userJson = serializeUser(request);
        String raw;
        try {
            raw = claude.complete(new ClaudeRequest("next-action", SYSTEM, userJson, 512));
        } catch (RuntimeException e) {
            return fail("grounding call failed");
        }
        return parseAction(raw);
    }

    private String serializeUser(NextActionRequest request) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("platform", request.platform() == null ? null : request.platform().wire());
        // Keyed "objective" (not "task") so the prose secret-scrubber doesn't match the "sk" in
        // "task" against its api-key rule and corrupt the key/value boundary of the JSON.
        payload.put("objective", request.task() == null ? "" : request.task());
        payload.put("observation", request.observation());
        payload.put("history", request.history());
        try {
            return mapper.writeValueAsString(payload);
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Defensively turn a model completion into a valid action node, or a {@code fail}. */
    JsonNode parseAction(String raw) {
        if (raw == null || raw.isBlank()) {
            return fail("empty completion");
        }
        String json = extractJsonObject(raw);
        if (json == null) {
            return fail("no JSON object in completion");
        }
        try {
            JsonNode node = mapper.readTree(json);
            if (!node.isObject()) {
                return fail("completion was not a JSON object");
            }
            JsonNode type = node.get("type");
            if (type == null || !type.isTextual() || !VALID_TYPES.contains(type.asText())) {
                return fail("missing or unknown action type");
            }
            return node;
        } catch (Exception e) {
            return fail("unparseable completion");
        }
    }

    /** Strip code fences / surrounding prose by slicing to the outermost {@code { ... }}. */
    private static String extractJsonObject(String raw) {
        int start = raw.indexOf('{');
        int end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return null;
        }
        return raw.substring(start, end + 1);
    }

    private JsonNode fail(String reason) {
        ObjectNode node = mapper.createObjectNode();
        node.put("type", "fail");
        node.put("reason", reason);
        return node;
    }
}

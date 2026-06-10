package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeResponder;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Deterministic stub for the "next-action" grounding task (PROCURE_COPILOT_PLAN.md §3.5.7) so the
 * perceive→act loop runs in CI without a live key. Given a serialized observation it returns a
 * sensible action: type into a searchbox when the task is a search, click an "add to cart" control
 * when present, otherwise {@code fail}. Real grounding ({@code stub-mode=false}) bypasses this.
 *
 * <p>The upstream secret-scrubber is prose-oriented and may redact numbers / partial tokens in the
 * serialized JSON, so this stub is defensive: it first repairs redaction markers and tries a
 * structured parse, then falls back to a regex scan over the (possibly still-corrupted) string. The
 * fields it keys off — {@code searchbox}, {@code add to cart}, element {@code idx} — survive scrubbing.
 */
@Component
public class NextActionResponder implements ClaudeResponder {

    private static final Pattern ELEMENT =
            Pattern.compile("\"idx\"\\s*:\\s*(\\d+)(.*?)(?=\"idx\"\\s*:|\\Z)", Pattern.DOTALL);
    private static final Pattern OBJECTIVE =
            Pattern.compile("\"objective\"\\s*:\\s*\"([^\"]*)\"");

    private final ObjectMapper mapper = new ObjectMapper();

    @Override
    public String task() {
        return "next-action";
    }

    @Override
    public String respond(ClaudeRequest request) {
        // Repair scrubber redaction markers (e.g. a redacted scroll height) back to a neutral 0 so the
        // payload is parseable; text fields the stub reads are untouched by the scrubber.
        String repaired = request.user() == null
                ? "{}"
                : request.user().replaceAll("\\[REDACTED[^\\]]*\\]", "0");

        try {
            JsonNode root = mapper.readTree(repaired);
            JsonNode elements = root.path("observation").path("elements");
            if (elements.isArray()) {
                String objective = root.path("objective").asText("").toLowerCase();
                int searchIdx = findStructured(elements, true);
                int addIdx = findStructured(elements, false);
                return decide(objective, repaired, searchIdx, addIdx);
            }
        } catch (Exception ignored) {
            // Fall through to the regex scan below.
        }
        return regexScan(repaired);
    }

    private int findStructured(JsonNode elements, boolean searchbox) {
        for (JsonNode el : elements) {
            String role = el.path("role").asText("");
            String tag = el.path("tag").asText("");
            String type = el.path("attrs").path("type").asText("");
            String name = el.path("name").asText("").toLowerCase();
            boolean match = searchbox
                    ? ("searchbox".equals(role)
                            || ("input".equals(tag) && ("search".equals(type) || "text".equals(type)))
                            || name.contains("search"))
                    : name.contains("add to cart");
            if (match) {
                return el.path("idx").asInt(-1);
            }
        }
        return -1;
    }

    /** Regex fallback when the JSON is too corrupted to parse but tokens still survive. */
    private String regexScan(String repaired) {
        String lower = repaired.toLowerCase();
        int searchIdx = -1;
        int addIdx = -1;
        Matcher m = ELEMENT.matcher(repaired);
        while (m.find()) {
            int idx = parseIdx(m.group(1));
            String chunk = m.group(2).toLowerCase();
            if (searchIdx < 0
                    && (chunk.contains("searchbox") || chunk.contains("\"type\":\"search\"")
                            || chunk.contains("search"))) {
                searchIdx = idx;
            }
            if (addIdx < 0 && chunk.contains("add to cart")) {
                addIdx = idx;
            }
        }
        return decide(lower, repaired, searchIdx, addIdx);
    }

    private String decide(String objective, String haystack, int searchIdx, int addIdx) {
        boolean wantsSearch = objective.contains("search") || haystack.toLowerCase().contains("search");
        if (wantsSearch && searchIdx >= 0) {
            return String.format(
                    "{\"type\":\"type\",\"idx\":%d,\"value\":\"%s\"}",
                    searchIdx, escape(searchTerm(objective, haystack)));
        }
        if (addIdx >= 0) {
            return String.format("{\"type\":\"click\",\"idx\":%d}", addIdx);
        }
        return "{\"type\":\"fail\",\"reason\":\"no actionable element for task\"}";
    }

    private static int parseIdx(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String searchTerm(String objective, String haystack) {
        String basis = objective != null && !objective.isBlank() ? objective : recoverObjective(haystack);
        String term = basis.replaceAll("(?i)search\\s*(for)?", "").trim();
        return term.isEmpty() ? basis.trim() : term;
    }

    private static String recoverObjective(String haystack) {
        Matcher m = OBJECTIVE.matcher(haystack);
        return m.find() ? m.group(1) : "";
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}

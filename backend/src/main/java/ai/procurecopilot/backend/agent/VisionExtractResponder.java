package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeResponder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Deterministic stub for the "vision-extract" task so the screenshot read path runs offline/in CI
 * without a live key. It can't see the image, so it echoes the requested item name as a sample
 * product with a fixed price. Real extraction ({@code stub-mode=false} + key present) bypasses this.
 */
@Component
public class VisionExtractResponder implements ClaudeResponder {

    private static final Pattern NAME = Pattern.compile("\"name\"\\s*:\\s*\"([^\"]*)\"");

    @Override
    public String task() {
        return "vision-extract";
    }

    @Override
    public String respond(ClaudeRequest request) {
        String user = request.user() == null ? "" : request.user();
        Matcher m = NAME.matcher(user);
        String name = m.find() && !m.group(1).isBlank() ? m.group(1) : "item";
        String title = capitalize(name) + " (sample)";
        return "{\"found\":true,\"title\":\"" + escape(title)
                + "\",\"pricePaise\":50000,\"mrpPaise\":60000,\"inStock\":true}";
    }

    private static String capitalize(String s) {
        String t = s.trim();
        return t.isEmpty() ? t : Character.toUpperCase(t.charAt(0)) + t.substring(1);
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}

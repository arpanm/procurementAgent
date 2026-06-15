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
        String base = capitalize(name);
        // Echo a small ranked list so the device's candidate/picker path runs offline. The first
        // candidate stays at ₹500 so the legacy single-quote assertions hold; alternates vary by size.
        String c1 = candidate(base + " (sample)", 50000, 60000);
        String c2 = candidate(base + " 1 Kg (sample)", 90000, 100000);
        String c3 = candidate(base + " 500 g (sample)", 48000, 55000);
        return "{\"found\":true,\"candidates\":[" + c1 + "," + c2 + "," + c3 + "]}";
    }

    private static String candidate(String title, long pricePaise, long mrpPaise) {
        return "{\"title\":\"" + escape(title) + "\",\"pricePaise\":" + pricePaise
                + ",\"mrpPaise\":" + mrpPaise + ",\"inStock\":true}";
    }

    private static String capitalize(String s) {
        String t = s.trim();
        return t.isEmpty() ? t : Character.toUpperCase(t.charAt(0)) + t.substring(1);
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}

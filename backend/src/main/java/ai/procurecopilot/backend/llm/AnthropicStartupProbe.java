package ai.procurecopilot.backend.llm;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Boot-time reachability check for the configured Anthropic model. A retired/invalid model id returns a
 * 404 from {@code /v1/messages}, which previously surfaced only as in-app "could not source / nothing
 * found" with no obvious cause (the model {@code claude-opus-4-20250514} was deprecated mid-use). This
 * probe makes that class of outage LOUD and immediate at startup so it's fixed by config, not debugged
 * through the device. Non-fatal: a failed probe logs an error banner but never blocks the app from
 * starting (transient network blips shouldn't gate boot).
 */
@Component
public class AnthropicStartupProbe {

    private static final Logger log = LoggerFactory.getLogger(AnthropicStartupProbe.class);

    private final ClaudeService claude;
    private final AnthropicProperties props;

    public AnthropicStartupProbe(ClaudeService claude, AnthropicProperties props) {
        this.claude = claude;
        this.props = props;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void verifyModelReachable() {
        if (props.isStub()) {
            log.info("Anthropic stub mode ON — skipping live model probe");
            return;
        }
        try {
            claude.complete(new ClaudeRequest(
                    "startup-probe", "Reply with the single word OK.", "ping", 8, null, null));
            log.info("Anthropic model '{}' reachable ✓", props.model());
        } catch (RuntimeException e) {
            log.error(
                    "\n========================================================================\n"
                    + " Anthropic model '{}' is NOT reachable: {}\n"
                    + " LLM-backed features (intent, planning, vision read) will fail until fixed.\n"
                    + " Fix: set ANTHROPIC_MODEL in backend/.env to a current model id, then restart.\n"
                    + "========================================================================",
                    props.model(), e.getMessage());
        }
    }
}

package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeResponder;
import org.springframework.stereotype.Component;

/**
 * Deterministic stub for the "intent" task so the slot-extraction fallback path runs in CI without a
 * live Anthropic key (PROCURE_COPILOT_PLAN.md §3.2). It returns a fixed, parseable JSON envelope: a
 * single placeholder item the rule parser could not resolve, which the {@link IntentService} fallback
 * consumes. In production (stub-mode off + key present) this bean is bypassed for a real model call.
 */
@Component
public class IntentResponder implements ClaudeResponder {

    @Override
    public String task() {
        return "intent";
    }

    @Override
    public String respond(ClaudeRequest request) {
        // Deterministic, parseable placeholder in the *new* schema (brand/variant/packSize present
        // but null). The rule parser is the real source of brand/variant/pack quality offline; this
        // only runs when the rule parser explicitly defers (e.g. unrecognized gibberish).
        return "{\"items\":[{\"canonicalItemId\":\"unknown\",\"name\":\"unknown\","
                + "\"qty\":1,\"unit\":\"piece\",\"brand\":null,\"variant\":null,"
                + "\"packSize\":null}],\"confidence\":0.5}";
    }
}

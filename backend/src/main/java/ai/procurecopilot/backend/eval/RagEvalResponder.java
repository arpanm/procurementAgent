package ai.procurecopilot.backend.eval;

import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeResponder;
import org.springframework.stereotype.Component;

/**
 * Deterministic stub for the "rag-eval" task so the self-improvement loop runs offline/in CI without
 * a live key. It can't reason over the evidence, so it proposes a single low-risk search-note
 * addition (auto-applied) recording that failures were reviewed, and no removals/policy flips. Real
 * evaluation ({@code stub-mode=false} + key present) bypasses this.
 */
@Component
public class RagEvalResponder implements ClaudeResponder {

    @Override
    public String task() {
        return RagEvalService.TASK;
    }

    @Override
    public String respond(ClaudeRequest request) {
        return "{\"summary\":\"stub: reviewed recent failures; no high-confidence token change\","
                + "\"additions\":{\"searchNotes\":"
                + "[\"eval(stub): recent add-to-cart failures reviewed — verify the ADD control label "
                + "and confirmation phrase still match the live page.\"]},"
                + "\"removals\":{},\"policyFlips\":{}}";
    }
}

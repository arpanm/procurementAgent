package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeResponder;
import org.springframework.stereotype.Component;

/**
 * Deterministic stub for the "plan" task (PROCURE_COPILOT_PLAN.md §3.3) so the agent loop runs in CI
 * without a live key. The MVP {@link PlanService} normalizes deterministically and does not call this
 * by default; the bean exists so the planning contract is complete and a future LLM-assisted planner
 * can drop in. It echoes both MVP platforms.
 */
@Component
public class PlanResponder implements ClaudeResponder {

    @Override
    public String task() {
        return "plan";
    }

    @Override
    public String respond(ClaudeRequest request) {
        return "{\"normalizedItems\":[],\"platforms\":[\"hyperpure\",\"amazon\"]}";
    }
}

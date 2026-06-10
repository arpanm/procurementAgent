package ai.procurecopilot.backend.agent;

import java.util.List;

/**
 * Verifier result (PROCURE_COPILOT_PLAN.md §3.3). {@code ok} is true only when {@code mismatches} is
 * empty; this is a hard safety gate before checkout, so any drift blocks.
 */
public record VerifyResponse(boolean ok, List<String> mismatches) {
}

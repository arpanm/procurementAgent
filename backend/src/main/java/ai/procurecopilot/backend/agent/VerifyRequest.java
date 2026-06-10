package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.PlatformId;
import java.util.List;

/**
 * Verifier input (PROCURE_COPILOT_PLAN.md §3.3, Epic 6): assert that a platform's live cart
 * ({@code actual}) matches the human-approved plan ({@code expected}) before any irreversible step.
 * Platform serializes to the lowercase wire string the Capacitor BackendClient sends.
 */
public record VerifyRequest(PlatformId platform, List<CartItem> expected, List<CartItem> actual) {
}

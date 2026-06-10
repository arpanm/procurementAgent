package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import java.util.List;

/**
 * Planning request (PROCURE_COPILOT_PLAN.md §3.3, Epic 1). {@code requestText} is the original
 * utterance for context; {@code items} are the extracted line items to normalize.
 */
public record PlanRequest(String requestText, List<Domain.RequestedItem> items) {
}

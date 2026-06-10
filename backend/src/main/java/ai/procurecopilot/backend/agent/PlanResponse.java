package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import java.util.List;

/**
 * Planning result. {@code normalizedItems} are deduped/canonicalized line items; {@code platforms}
 * are the lowercase wire platform ids to query (always both MVP platforms: "hyperpure", "amazon").
 */
public record PlanResponse(List<Domain.RequestedItem> normalizedItems, List<String> platforms) {
}

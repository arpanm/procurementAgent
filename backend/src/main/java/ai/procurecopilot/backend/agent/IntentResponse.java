package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import java.util.List;

/**
 * Slot-extraction result. Field names are the camelCase wire contract the app's BackendClient
 * expects: {@code items} (each {canonicalItemId, name, qty, unit}) and a 0..1 {@code confidence}.
 */
public record IntentResponse(List<Domain.RequestedItem> items, double confidence) {
}

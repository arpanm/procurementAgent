package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.common.PlatformId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * Procurement planner (PROCURE_COPILOT_PLAN.md §3.3, Epic 1). Deterministically normalizes the
 * extracted items (canonicalize ids/names, merge duplicate item+unit lines by summing quantity) and
 * always returns both MVP platforms to query. A Claude "plan" stub is registered for contract
 * completeness; the MVP normalization itself is pure so it is fast and predictable.
 */
@Service
public class PlanService {

    public PlanResponse plan(PlanRequest request) {
        List<Domain.RequestedItem> input = request == null || request.items() == null
                ? List.of() : request.items();

        // Merge by (canonicalItemId, unit), preserving first-seen order, summing quantities.
        Map<String, Domain.RequestedItem> merged = new LinkedHashMap<>();
        for (Domain.RequestedItem item : input) {
            if (item == null) {
                continue;
            }
            String canonicalId = canonicalize(item.canonicalItemId(), item.name());
            if (canonicalId.isEmpty()) {
                continue;
            }
            String name = item.name() == null || item.name().isBlank()
                    ? canonicalId : item.name().trim().toLowerCase();
            String unit = item.unit() == null || item.unit().isBlank()
                    ? "piece" : item.unit().trim().toLowerCase();
            int qty = Math.max(0, item.qty());
            if (qty == 0) {
                continue;
            }
            String key = canonicalId + "\u0000" + unit;
            Domain.RequestedItem existing = merged.get(key);
            if (existing == null) {
                // Preserve the brand/variant/pack-size refinements — they are what lets each platform
                // adapter search for the SPECIFIC SKU (e.g. "Milky Mist paneer 500 g") instead of a
                // bare "paneer". Dropping them here was silently collapsing the order to a generic item.
                merged.put(key, new Domain.RequestedItem(
                        canonicalId, name, qty, unit,
                        item.brand(), item.variant(), item.packSize()));
            } else {
                // Keep the first-seen refinements; only the quantity accumulates across merged lines.
                merged.put(key, new Domain.RequestedItem(
                        existing.canonicalItemId(), existing.name(), existing.qty() + qty, unit,
                        existing.brand(), existing.variant(), existing.packSize()));
            }
        }

        List<Domain.RequestedItem> normalized = new ArrayList<>(merged.values());

        List<String> platforms = new ArrayList<>();
        for (PlatformId p : PlatformId.values()) {
            platforms.add(p.wire());
        }
        return new PlanResponse(normalized, platforms);
    }

    private static String canonicalize(String canonicalItemId, String name) {
        String base = canonicalItemId != null && !canonicalItemId.isBlank()
                ? canonicalItemId
                : (name == null ? "" : name);
        return base.trim().toLowerCase().replaceAll("\\s+", "");
    }
}

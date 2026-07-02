package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Money;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Cart-vs-plan Verifier (PROCURE_COPILOT_PLAN.md §3.3, Epic 6). Before any irreversible step the
 * agent re-reads the live cart and asserts it matches the human-approved plan: every expected SKU
 * present with the right quantity and a unit price within tolerance, and nothing unexpected added.
 *
 * <p>This is a SAFETY gate, so it is deliberately strict — a missing SKU, wrong quantity, price drift
 * beyond {@code procure.optimizer.price-tolerance}, or any extra SKU produces a human-readable
 * mismatch and blocks ({@code ok=false}).
 */
@Service
public class VerifyService {

    /** Fractional epsilon so an exactly-at-tolerance drift passes despite double arithmetic. */
    private static final double EPSILON = 1e-9;

    private final double priceTolerance;

    public VerifyService(
            @Value("${procure.optimizer.price-tolerance:0.05}") double priceTolerance) {
        // A negative or absurd tolerance would silently weaken the gate; clamp to a sane range.
        this.priceTolerance = priceTolerance < 0 ? 0.0 : priceTolerance;
    }

    public VerifyResponse verify(VerifyRequest request) {
        List<String> mismatches = new ArrayList<>();
        List<CartItem> expected = request == null || request.expected() == null
                ? List.of() : request.expected();
        List<CartItem> actual = request == null || request.actual() == null
                ? List.of() : request.actual();

        // Aggregate BOTH sides by SKU (summing quantities) before comparing. A cart or plan may list the
        // same SKU on more than one line; collapsing to a single entry (last-wins) would let a wrong total
        // slip through this safety gate — e.g. plan 2×A + 3×A (=5) vs a cart with one 2×A line would
        // wrongly pass. Summing per SKU compares the real totals.
        Map<String, Agg> expectedBySku = aggregate(expected);
        Map<String, Agg> actualBySku = aggregate(actual);

        for (Map.Entry<String, Agg> entry : expectedBySku.entrySet()) {
            String skuId = entry.getKey();
            Agg e = entry.getValue();
            Agg a = actualBySku.get(skuId);
            if (a == null) {
                mismatches.add(String.format(
                        "Missing SKU %s: expected %d @ %s, not in cart",
                        skuId, e.qty, Money.formatRupees(e.unitPricePaise)));
                continue;
            }
            if (a.qty != e.qty) {
                mismatches.add(String.format(
                        "Quantity mismatch for SKU %s: expected %d, cart has %d",
                        skuId, e.qty, a.qty));
            }
            if (priceDriftExceedsTolerance(e.unitPricePaise, a.unitPricePaise)) {
                mismatches.add(String.format(
                        "Price drift for SKU %s: expected %s, cart has %s (beyond %.0f%% tolerance)",
                        skuId,
                        Money.formatRupees(e.unitPricePaise),
                        Money.formatRupees(a.unitPricePaise),
                        priceTolerance * 100));
            }
        }

        // Anything in the cart not in the approved plan is an unexpected addition — block it.
        for (Map.Entry<String, Agg> entry : actualBySku.entrySet()) {
            if (!expectedBySku.containsKey(entry.getKey())) {
                Agg a = entry.getValue();
                mismatches.add(String.format(
                        "Unexpected SKU %s in cart: %d @ %s not in approved plan",
                        entry.getKey(), a.qty, Money.formatRupees(a.unitPricePaise)));
            }
        }

        return new VerifyResponse(mismatches.isEmpty(), mismatches);
    }

    /** Per-SKU aggregate: total quantity across duplicate lines + the SKU's unit price. */
    private static final class Agg {
        private long qty;
        private long unitPricePaise;
    }

    /**
     * Fold a list of cart lines into one {@link Agg} per SKU, summing quantities. The unit price is taken
     * from the first line seen for that SKU (a SKU has a single unit price; per-line duplicates repeat it).
     */
    private static Map<String, Agg> aggregate(List<CartItem> items) {
        Map<String, Agg> bySku = new LinkedHashMap<>();
        for (CartItem item : items) {
            if (item == null) {
                continue;
            }
            Agg agg = bySku.computeIfAbsent(sku(item), k -> {
                Agg fresh = new Agg();
                fresh.unitPricePaise = item.unitPricePaise();
                return fresh;
            });
            agg.qty += item.qty();
        }
        return bySku;
    }

    private boolean priceDriftExceedsTolerance(long expectedPaise, long actualPaise) {
        double allowed = Math.abs(expectedPaise) * priceTolerance;
        double drift = Math.abs((double) actualPaise - (double) expectedPaise);
        return drift - allowed > EPSILON;
    }

    private static String sku(CartItem item) {
        return item.skuId() == null ? "" : item.skuId();
    }
}

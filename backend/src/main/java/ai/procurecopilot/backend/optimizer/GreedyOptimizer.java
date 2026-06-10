package ai.procurecopilot.backend.optimizer;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.common.Money;
import ai.procurecopilot.backend.common.PlatformId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/**
 * Deterministic greedy cart-split optimizer (PROCURE_COPILOT_PLAN.md §4, "Greedy heuristic (MVP)").
 *
 * <p>Algorithm:
 * <ol>
 *   <li>Assign each item to its cheapest available in-stock platform, splitting the remainder to the
 *       next cheapest when a stock cap is hit. Out-of-stock / unavailable demand becomes unfulfilled.</li>
 *   <li>For any used platform below its MOV, pick the cheaper of (a) topping up to the MOV vs
 *       (b) rerouting its items onto the other platform to avoid a second delivery fee.</li>
 *   <li>Respect credit caps: a platform is {@code payableOnCredit} only when its real total fits the
 *       available credit line.</li>
 *   <li>Emit a rupee P&amp;L vs the cheapest single-platform baseline, with a plain-language reason
 *       per line.</li>
 * </ol>
 *
 * <p>The optimizer is pure and deterministic: identical input always yields identical output, and it
 * never calls an LLM. All money is integer paise.
 */
@Service
public class GreedyOptimizer implements Optimizer {

    /** A concrete decision to buy {@code qty} of an item on one platform at a unit price. */
    private static final class Line {
        final String canonicalItemId;
        final String itemName;
        PlatformId platform;
        String skuId;
        int qty;
        long unitPricePaise;
        ReasonCode reasonCode;
        /** Captured for narration: the cheapest alternative unit price on another platform, if any. */
        Long alternativeUnitPricePaise;
        PlatformId cheapestPlatform;
        Integer cheapestPlatformCap;

        Line(String canonicalItemId, String itemName, PlatformId platform, String skuId,
                int qty, long unitPricePaise, ReasonCode reasonCode) {
            this.canonicalItemId = canonicalItemId;
            this.itemName = itemName;
            this.platform = platform;
            this.skuId = skuId;
            this.qty = qty;
            this.unitPricePaise = unitPricePaise;
            this.reasonCode = reasonCode;
        }

        Line copy() {
            Line c = new Line(canonicalItemId, itemName, platform, skuId, qty, unitPricePaise, reasonCode);
            c.alternativeUnitPricePaise = alternativeUnitPricePaise;
            c.cheapestPlatform = cheapestPlatform;
            c.cheapestPlatformCap = cheapestPlatformCap;
            return c;
        }
    }

    private enum ReasonCode {
        CHEAPEST,
        ONLY_OPTION,
        SPLIT_OVERFLOW,
        REROUTE_MOV
    }

    @Override
    public Domain.Allocation optimize(Domain.OptimizeRequest req) {
        List<Domain.RequestedItem> items = req == null || req.items() == null ? List.of() : req.items();
        List<Domain.Quote> quotes = req == null || req.quotes() == null ? List.of() : req.quotes();
        List<Domain.PlatformConstraints> constraints =
                req == null || req.constraints() == null ? List.of() : req.constraints();

        Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform =
                indexConstraints(quotes, constraints);

        // Per (canonicalItemId, platform): the cheapest in-stock quote.
        Map<String, Map<PlatformId, Domain.Quote>> bestQuote = indexBestInStockQuotes(quotes);

        List<Line> lines = new ArrayList<>();
        List<Domain.Unfulfilled> unfulfilled = new ArrayList<>();

        for (Domain.RequestedItem item : items) {
            if (item == null) {
                continue;
            }
            allocateItem(item, bestQuote.getOrDefault(item.canonicalItemId(), Map.of()), lines, unfulfilled);
        }

        resolveMovConstraints(lines, bestQuote, constraintByPlatform);

        return assemble(lines, unfulfilled, items, bestQuote, constraintByPlatform);
    }

    // ---------------------------------------------------------------------------------------------
    // Step 0 — indexing
    // ---------------------------------------------------------------------------------------------

    private Map<PlatformId, Domain.PlatformConstraints> indexConstraints(
            List<Domain.Quote> quotes, List<Domain.PlatformConstraints> constraints) {
        Map<PlatformId, Domain.PlatformConstraints> map = new LinkedHashMap<>();
        for (Domain.PlatformConstraints c : constraints) {
            if (c != null && c.platform() != null) {
                map.put(c.platform(), c);
            }
        }
        // Synthesize a constraint for any platform that only appears in quotes, using quote-carried
        // MOV / delivery fee where present so the optimizer never NPEs on a missing constraint.
        for (Domain.Quote q : quotes) {
            if (q == null || q.platform() == null || map.containsKey(q.platform())) {
                continue;
            }
            long mov = q.movPaise() != null ? q.movPaise() : 0L;
            long fee = q.deliveryFeePaise() != null ? q.deliveryFeePaise() : 0L;
            map.put(q.platform(), new Domain.PlatformConstraints(q.platform(), mov, fee, null));
        }
        return map;
    }

    private Map<String, Map<PlatformId, Domain.Quote>> indexBestInStockQuotes(List<Domain.Quote> quotes) {
        Map<String, Map<PlatformId, Domain.Quote>> map = new HashMap<>();
        for (Domain.Quote q : quotes) {
            if (q == null || !q.inStock() || q.platform() == null || q.canonicalItemId() == null) {
                continue;
            }
            // A non-positive stock cap means nothing is purchasable; treat as unavailable.
            if (q.stockCap() != null && q.stockCap() <= 0) {
                continue;
            }
            Map<PlatformId, Domain.Quote> perPlatform =
                    map.computeIfAbsent(q.canonicalItemId(), k -> new LinkedHashMap<>());
            Domain.Quote existing = perPlatform.get(q.platform());
            if (existing == null || q.pricePaise() < existing.pricePaise()) {
                perPlatform.put(q.platform(), q);
            }
        }
        return map;
    }

    // ---------------------------------------------------------------------------------------------
    // Step 1 — cheapest assignment with stock-cap splitting
    // ---------------------------------------------------------------------------------------------

    private void allocateItem(
            Domain.RequestedItem item,
            Map<PlatformId, Domain.Quote> options,
            List<Line> lines,
            List<Domain.Unfulfilled> unfulfilled) {

        int demand = Math.max(0, item.qty());
        if (demand == 0) {
            return;
        }
        if (options.isEmpty()) {
            unfulfilled.add(new Domain.Unfulfilled(
                    item.canonicalItemId(),
                    item.name(),
                    "out of stock on all platforms"));
            return;
        }

        // Cheapest first; deterministic tie-break by platform wire name.
        List<Domain.Quote> sorted = new ArrayList<>(options.values());
        sorted.sort(Comparator
                .comparingLong(Domain.Quote::pricePaise)
                .thenComparing(q -> q.platform().wire()));

        Domain.Quote cheapest = sorted.get(0);
        boolean multiPlatform = sorted.size() > 1;
        long secondCheapestPrice = multiPlatform ? sorted.get(1).pricePaise() : -1L;

        int remaining = demand;
        for (Domain.Quote q : sorted) {
            if (remaining <= 0) {
                break;
            }
            int cap = q.stockCap() != null ? q.stockCap() : remaining;
            int take = Math.min(remaining, cap);
            if (take <= 0) {
                continue;
            }
            ReasonCode code;
            if (q == cheapest) {
                code = multiPlatform ? ReasonCode.CHEAPEST : ReasonCode.ONLY_OPTION;
            } else {
                code = ReasonCode.SPLIT_OVERFLOW;
            }
            Line line = new Line(
                    item.canonicalItemId(), item.name(), q.platform(), q.skuId(),
                    take, q.pricePaise(), code);
            if (code == ReasonCode.CHEAPEST && secondCheapestPrice >= 0) {
                line.alternativeUnitPricePaise = secondCheapestPrice;
            }
            line.cheapestPlatform = cheapest.platform();
            line.cheapestPlatformCap = cheapest.stockCap();
            lines.add(line);
            remaining -= take;
        }

        if (remaining > 0) {
            int available = demand - remaining;
            unfulfilled.add(new Domain.Unfulfilled(
                    item.canonicalItemId(),
                    item.name(),
                    "only " + available + " of " + demand + " " + safeUnit(item)
                            + " available across platforms"));
        }
    }

    private String safeUnit(Domain.RequestedItem item) {
        return item.unit() == null || item.unit().isBlank() ? "units" : item.unit();
    }

    // ---------------------------------------------------------------------------------------------
    // Step 2 — MOV resolution: top-up vs reroute, pick the cheaper
    // ---------------------------------------------------------------------------------------------

    private void resolveMovConstraints(
            List<Line> lines,
            Map<String, Map<PlatformId, Domain.Quote>> bestQuote,
            Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform) {

        boolean changed = true;
        int guard = 0;
        // With two platforms a single pass settles; the guard bounds any future N-platform churn.
        while (changed && guard++ < 8) {
            changed = false;
            for (PlatformId p : usedPlatforms(lines)) {
                long subtotal = subtotal(lines, p);
                long mov = mov(constraintByPlatform, p);
                if (subtotal >= mov) {
                    continue;
                }
                List<Line> rerouted = tryReroute(lines, p, bestQuote, constraintByPlatform);
                if (rerouted != null
                        && effectiveCost(rerouted, constraintByPlatform)
                                < effectiveCost(lines, constraintByPlatform)) {
                    lines.clear();
                    lines.addAll(rerouted);
                    changed = true;
                    break;
                }
            }
        }
    }

    /**
     * Attempt to move every line on {@code from} onto another platform that has the item in stock and
     * spare capacity (cheapest alternative wins, then deterministic by wire name). Returns a new line
     * list, or {@code null} when reroute is infeasible (some item cannot be fully re-sourced) so the
     * caller keeps the top-up option.
     */
    private List<Line> tryReroute(
            List<Line> lines, PlatformId from,
            Map<String, Map<PlatformId, Domain.Quote>> bestQuote,
            Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform) {

        List<Line> result = new ArrayList<>();
        List<Line> toMove = new ArrayList<>();
        for (Line l : lines) {
            if (l.platform == from) {
                toMove.add(l);
            } else {
                result.add(l.copy());
            }
        }
        if (toMove.isEmpty()) {
            return null;
        }

        for (Line moving : toMove) {
            Map<PlatformId, Domain.Quote> options =
                    bestQuote.getOrDefault(moving.canonicalItemId, Map.of());
            PlatformId target = null;
            Domain.Quote targetQuote = null;
            for (PlatformId candidate : sortedPlatforms(constraintByPlatform.keySet())) {
                if (candidate == from) {
                    continue;
                }
                Domain.Quote q = options.get(candidate);
                if (q == null) {
                    continue;
                }
                int alreadyOnCandidate = assignedQty(result, moving.canonicalItemId, candidate);
                if (q.stockCap() != null && alreadyOnCandidate + moving.qty > q.stockCap()) {
                    continue;
                }
                if (targetQuote == null || q.pricePaise() < targetQuote.pricePaise()) {
                    target = candidate;
                    targetQuote = q;
                }
            }
            if (target == null) {
                return null; // cannot move this line elsewhere → reroute infeasible
            }
            Line moved = moving.copy();
            moved.platform = target;
            moved.unitPricePaise = targetQuote.pricePaise();
            moved.skuId = targetQuote.skuId();
            moved.reasonCode = ReasonCode.REROUTE_MOV;
            result.add(moved);
        }
        return result;
    }

    private List<PlatformId> sortedPlatforms(Set<PlatformId> platforms) {
        List<PlatformId> list = new ArrayList<>(platforms);
        list.sort(Comparator.comparing(PlatformId::wire));
        return list;
    }

    // ---------------------------------------------------------------------------------------------
    // Step 3 — assemble the explainable allocation
    // ---------------------------------------------------------------------------------------------

    private Domain.Allocation assemble(
            List<Line> lines,
            List<Domain.Unfulfilled> unfulfilled,
            List<Domain.RequestedItem> items,
            Map<String, Map<PlatformId, Domain.Quote>> bestQuote,
            Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform) {

        // Preserve a stable platform order for output.
        Set<PlatformId> platformsInUse = usedPlatforms(lines);

        List<Domain.PlatformAllocation> perPlatform = new ArrayList<>();
        long grandTotal = 0;
        for (PlatformId p : platformsInUse) {
            List<Domain.AllocationLine> outLines = new ArrayList<>();
            long subtotal = 0;
            for (Line l : lines) {
                if (l.platform != p) {
                    continue;
                }
                long lineTotal = (long) l.qty * l.unitPricePaise;
                subtotal += lineTotal;
                outLines.add(new Domain.AllocationLine(
                        l.canonicalItemId, l.itemName, l.platform, l.skuId,
                        l.qty, l.unitPricePaise, lineTotal, narrate(l)));
            }
            Domain.PlatformConstraints c = constraintByPlatform.get(p);
            long deliveryFee = c != null ? c.deliveryFeePaise() : 0L;
            long mov = c != null ? c.movPaise() : 0L;
            long total = subtotal + deliveryFee;
            boolean meetsMov = subtotal >= mov;
            boolean payableOnCredit = c != null
                    && c.creditAvailablePaise() != null
                    && total <= c.creditAvailablePaise();
            perPlatform.add(new Domain.PlatformAllocation(
                    p, outLines, subtotal, deliveryFee, total, meetsMov, payableOnCredit));
            grandTotal += total;
        }

        long baseline = singlePlatformBaseline(items, bestQuote, constraintByPlatform, grandTotal);
        long saving = grandTotal - baseline;

        return new Domain.Allocation(perPlatform, grandTotal, baseline, saving, unfulfilled);
    }

    /**
     * Cheapest single-platform total: everything bought on one platform that can fulfil all demand in
     * stock (within caps), including that platform's delivery fee. If no single platform can fulfil
     * everything, the split allocation is the only feasible plan, so the baseline equals the grand
     * total (zero attributable saving).
     */
    private long singlePlatformBaseline(
            List<Domain.RequestedItem> items,
            Map<String, Map<PlatformId, Domain.Quote>> bestQuote,
            Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform,
            long grandTotalFallback) {

        long best = Long.MAX_VALUE;
        for (PlatformId p : constraintByPlatform.keySet()) {
            long subtotal = 0;
            boolean canFulfilAll = true;
            for (Domain.RequestedItem item : items) {
                if (item == null || item.qty() <= 0) {
                    continue;
                }
                Domain.Quote q = bestQuote.getOrDefault(item.canonicalItemId(), Map.of()).get(p);
                if (q == null) {
                    canFulfilAll = false;
                    break;
                }
                if (q.stockCap() != null && q.stockCap() < item.qty()) {
                    canFulfilAll = false;
                    break;
                }
                subtotal += (long) item.qty() * q.pricePaise();
            }
            if (!canFulfilAll) {
                continue;
            }
            Domain.PlatformConstraints c = constraintByPlatform.get(p);
            long deliveryFee = c != null ? c.deliveryFeePaise() : 0L;
            best = Math.min(best, subtotal + deliveryFee);
        }
        return best == Long.MAX_VALUE ? grandTotalFallback : best;
    }

    // ---------------------------------------------------------------------------------------------
    // Narration
    // ---------------------------------------------------------------------------------------------

    private String narrate(Line l) {
        String platform = capitalize(l.platform.wire());
        return switch (l.reasonCode) {
            case CHEAPEST -> {
                if (l.alternativeUnitPricePaise != null && l.alternativeUnitPricePaise > l.unitPricePaise) {
                    long diff = l.alternativeUnitPricePaise - l.unitPricePaise;
                    yield "cheaper on " + platform + " by " + Money.formatRupees(diff) + " per "
                            + "unit (" + Money.formatRupees(l.unitPricePaise) + " each)";
                }
                yield "best price on " + platform + " at " + Money.formatRupees(l.unitPricePaise) + " each";
            }
            case ONLY_OPTION -> "only " + platform + " has it in stock at "
                    + Money.formatRupees(l.unitPricePaise) + " each";
            case SPLIT_OVERFLOW -> {
                String cheaper = l.cheapestPlatform != null
                        ? capitalize(l.cheapestPlatform.wire()) : "the cheaper platform";
                String cap = l.cheapestPlatformCap != null ? " (capped at " + l.cheapestPlatformCap + ")" : "";
                yield cheaper + " stock limited" + cap + "; bought remaining " + l.qty + " on "
                        + platform + " at " + Money.formatRupees(l.unitPricePaise) + " each";
            }
            case REROUTE_MOV -> "moved to " + platform + " at " + Money.formatRupees(l.unitPricePaise)
                    + " each to avoid a second delivery fee / meet minimum order";
        };
    }

    private static String capitalize(String s) {
        if (s == null || s.isEmpty()) {
            return s;
        }
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    // ---------------------------------------------------------------------------------------------
    // Cost helpers
    // ---------------------------------------------------------------------------------------------

    /** Distinct platforms with at least one line, in stable insertion order. */
    private Set<PlatformId> usedPlatforms(List<Line> lines) {
        Set<PlatformId> set = new LinkedHashSet<>();
        for (Line l : lines) {
            if (l.qty > 0) {
                set.add(l.platform);
            }
        }
        return set;
    }

    private long subtotal(List<Line> lines, PlatformId p) {
        long sum = 0;
        for (Line l : lines) {
            if (l.platform == p) {
                sum += (long) l.qty * l.unitPricePaise;
            }
        }
        return sum;
    }

    private long mov(Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform, PlatformId p) {
        Domain.PlatformConstraints c = constraintByPlatform.get(p);
        return c != null ? c.movPaise() : 0L;
    }

    /**
     * Cost used only to DECIDE top-up vs reroute: real goods + delivery fees of used platforms, plus
     * the top-up each used platform would need to spend to reach its MOV. The emitted grand total
     * reports real spend only; this effective figure makes the comparison fair.
     */
    private long effectiveCost(
            List<Line> lines, Map<PlatformId, Domain.PlatformConstraints> constraintByPlatform) {
        long total = 0;
        for (PlatformId p : usedPlatforms(lines)) {
            long subtotal = subtotal(lines, p);
            Domain.PlatformConstraints c = constraintByPlatform.get(p);
            long deliveryFee = c != null ? c.deliveryFeePaise() : 0L;
            long mov = c != null ? c.movPaise() : 0L;
            long topUp = Math.max(0L, mov - subtotal);
            total += subtotal + deliveryFee + topUp;
        }
        return total;
    }

    private int assignedQty(List<Line> lines, String canonicalItemId, PlatformId p) {
        int sum = 0;
        for (Line l : lines) {
            if (l.platform == p && l.canonicalItemId.equals(canonicalItemId)) {
                sum += l.qty;
            }
        }
        return sum;
    }
}

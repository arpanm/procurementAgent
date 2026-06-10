package ai.procurecopilot.backend.common;

import java.util.List;

/**
 * Shared domain records (PROCURE_COPILOT_PLAN.md §7), used by the optimizer (Epic 4) and the agent
 * brain endpoints. All money is integer paise. These records are the cross-module contract; modules
 * must not redefine them.
 */
public final class Domain {

    private Domain() {
    }

    /**
     * A required line item after intent extraction + SKU normalization.
     *
     * <p>{@code qty}/{@code unit} carry the count (e.g. 5 "packet"); {@code brand} ("India Gate"),
     * {@code variant} ("basmati"/"lite") and {@code packSize} ("1 kg") are optional refinements the
     * model/parser extracts to disambiguate the SKU on each platform. All three may be {@code null}.
     */
    public record RequestedItem(
            String canonicalItemId,
            String name,
            int qty,
            String unit,
            String brand,
            String variant,
            String packSize) {

        /** Back-compat constructor for the common case with no brand/variant/pack-size refinement. */
        public RequestedItem(String canonicalItemId, String name, int qty, String unit) {
            this(canonicalItemId, name, qty, unit, null, null, null);
        }
    }

    /** A live quote read off a platform for a SKU. */
    public record Quote(
            PlatformId platform,
            String skuId,
            String canonicalItemId,
            String title,
            long pricePaise,
            Long mrpPaise,
            boolean inStock,
            Integer stockCap,
            String deliveryDate,
            Long movPaise,
            Long deliveryFeePaise) {
    }

    /** Per-platform commercial constraints used by the optimizer. */
    public record PlatformConstraints(
            PlatformId platform,
            long movPaise,
            long deliveryFeePaise,
            Long creditAvailablePaise) {
    }

    /** One allocation line: buy {@code qty} of an item on a platform with an explainable reason. */
    public record AllocationLine(
            String canonicalItemId,
            String itemName,
            PlatformId platform,
            String skuId,
            int qty,
            long unitPricePaise,
            long lineTotalPaise,
            String reason) {
    }

    /** Per-platform rollup within an allocation. */
    public record PlatformAllocation(
            PlatformId platform,
            List<AllocationLine> lines,
            long subtotalPaise,
            long deliveryFeePaise,
            long totalPaise,
            boolean meetsMov,
            boolean payableOnCredit) {
    }

    /** An item that could not be sourced on any platform. */
    public record Unfulfilled(String canonicalItemId, String itemName, String reason) {
    }

    /** A full optimizer result with an explainable rupee P&L (§4). */
    public record Allocation(
            List<PlatformAllocation> perPlatform,
            long grandTotalPaise,
            long singlePlatformBaselinePaise,
            long savingPaise,
            List<Unfulfilled> unfulfilled) {
    }

    /** Optimizer input: demand + quotes + per-platform constraints. */
    public record OptimizeRequest(
            List<RequestedItem> items,
            List<Quote> quotes,
            List<PlatformConstraints> constraints) {
    }
}

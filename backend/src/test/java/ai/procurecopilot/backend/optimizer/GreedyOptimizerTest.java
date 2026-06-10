package ai.procurecopilot.backend.optimizer;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.common.PlatformId;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Acceptance tests for the greedy cart-split optimizer (PROCURE_COPILOT_PLAN.md §4, §9.1):
 * demand met exactly, stock caps respected, MOV top-up vs reroute picks the cheaper, credit caps
 * honoured, out-of-stock never allocated, saving computed vs single-platform baseline, and graceful
 * empty input.
 */
class GreedyOptimizerTest {

    private final GreedyOptimizer optimizer = new GreedyOptimizer();

    private static final PlatformId H = PlatformId.HYPERPURE;
    private static final PlatformId A = PlatformId.AMAZON;

    // ----- builders -----------------------------------------------------------------------------

    private static Domain.RequestedItem item(String id, int qty, String unit) {
        return new Domain.RequestedItem(id, id, qty, unit);
    }

    private static Domain.Quote quote(
            PlatformId p, String canonicalId, long price, boolean inStock, Integer cap) {
        return new Domain.Quote(p, p.wire() + "-" + canonicalId, canonicalId, canonicalId + " title",
                price, null, inStock, cap, "2026-06-10", null, null);
    }

    private static Domain.PlatformConstraints constraint(
            PlatformId p, long mov, long fee, Long credit) {
        return new Domain.PlatformConstraints(p, mov, fee, credit);
    }

    private long allocatedQty(Domain.Allocation a, String canonicalId) {
        long sum = 0;
        for (Domain.PlatformAllocation pa : a.perPlatform()) {
            for (Domain.AllocationLine l : pa.lines()) {
                if (l.canonicalItemId().equals(canonicalId)) {
                    sum += l.qty();
                }
            }
        }
        return sum;
    }

    private long qtyOn(Domain.Allocation a, String canonicalId, PlatformId p) {
        long sum = 0;
        for (Domain.PlatformAllocation pa : a.perPlatform()) {
            if (pa.platform() != p) {
                continue;
            }
            for (Domain.AllocationLine l : pa.lines()) {
                if (l.canonicalItemId().equals(canonicalId)) {
                    sum += l.qty();
                }
            }
        }
        return sum;
    }

    // ----- tests --------------------------------------------------------------------------------

    @Test
    void demandMetExactly_onCheapestPlatform() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("potato", 5, "kg")),
                List.of(quote(H, "potato", 1000, true, null), quote(A, "potato", 1200, true, null)),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(allocatedQty(a, "potato")).isEqualTo(5);
        assertThat(qtyOn(a, "potato", H)).isEqualTo(5);
        assertThat(qtyOn(a, "potato", A)).isZero();
        assertThat(a.unfulfilled()).isEmpty();
        assertThat(a.grandTotalPaise()).isEqualTo(5000);
    }

    @Test
    void stockCapRespected_splitsRemainderToNextCheapest() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("onion", 10, "kg")),
                List.of(quote(H, "onion", 800, true, 6), quote(A, "onion", 900, true, null)),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(allocatedQty(a, "onion")).isEqualTo(10);
        assertThat(qtyOn(a, "onion", H)).isEqualTo(6); // capped
        assertThat(qtyOn(a, "onion", A)).isEqualTo(4); // remainder
        assertThat(a.unfulfilled()).isEmpty();
        assertThat(a.grandTotalPaise()).isEqualTo(6 * 800 + 4 * 900);
    }

    @Test
    void partialStock_shortfallBecomesUnfulfilled() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("onion", 10, "kg")),
                List.of(quote(H, "onion", 800, true, 6)),
                List.of(constraint(H, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(qtyOn(a, "onion", H)).isEqualTo(6);
        assertThat(a.unfulfilled()).hasSize(1);
        assertThat(a.unfulfilled().get(0).canonicalItemId()).isEqualTo("onion");
        assertThat(a.unfulfilled().get(0).reason()).contains("6 of 10");
    }

    @Test
    void belowMov_reroutesWhenRerouteIsCheaper() {
        // Rice cheapest on H but H has a high MOV and a high delivery fee. Moving the single line to
        // Amazon avoids the Hyperpure delivery fee and the wasteful top-up.
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("rice", 1, "kg")),
                List.of(quote(H, "rice", 1000, true, null), quote(A, "rice", 1100, true, null)),
                List.of(constraint(H, 5000, 2000, null), constraint(A, 0, 500, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(qtyOn(a, "rice", A)).isEqualTo(1);
        assertThat(qtyOn(a, "rice", H)).isZero();
        assertThat(a.grandTotalPaise()).isEqualTo(1100 + 500);
    }

    @Test
    void belowMov_topsUpWhenRerouteIsMoreExpensive() {
        // Rerouting to Amazon would cost far more (₹90 vs ₹10 a kg), so the optimizer keeps the item
        // on Hyperpure rather than rerouting.
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("rice", 1, "kg")),
                List.of(quote(H, "rice", 1000, true, null), quote(A, "rice", 9000, true, null)),
                List.of(constraint(H, 1200, 100, null), constraint(A, 0, 100, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(qtyOn(a, "rice", H)).isEqualTo(1);
        assertThat(qtyOn(a, "rice", A)).isZero();
        assertThat(a.grandTotalPaise()).isEqualTo(1000 + 100);
        // Real subtotal stays below MOV; the UX must surface that a top-up is needed.
        Domain.PlatformAllocation hp = a.perPlatform().get(0);
        assertThat(hp.platform()).isEqualTo(H);
        assertThat(hp.meetsMov()).isFalse();
    }

    @Test
    void creditCapHonoured_payableOnCreditFalseWhenExceeded() {
        Domain.OptimizeRequest exceeded = new Domain.OptimizeRequest(
                List.of(item("oil", 2, "carton")),
                List.of(quote(H, "oil", 3000, true, null)),
                List.of(constraint(H, 0, 0, 5000L)));

        Domain.Allocation a = optimizer.optimize(exceeded);
        assertThat(a.perPlatform()).hasSize(1);
        assertThat(a.perPlatform().get(0).totalPaise()).isEqualTo(6000);
        assertThat(a.perPlatform().get(0).payableOnCredit()).isFalse();

        Domain.OptimizeRequest within = new Domain.OptimizeRequest(
                List.of(item("oil", 2, "carton")),
                List.of(quote(H, "oil", 3000, true, null)),
                List.of(constraint(H, 0, 0, 7000L)));
        assertThat(optimizer.optimize(within).perPlatform().get(0).payableOnCredit()).isTrue();
    }

    @Test
    void creditNull_isNotPayableOnCredit() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("oil", 1, "carton")),
                List.of(quote(H, "oil", 3000, true, null)),
                List.of(constraint(H, 0, 0, null)));
        assertThat(optimizer.optimize(req).perPlatform().get(0).payableOnCredit()).isFalse();
    }

    @Test
    void outOfStockEverywhere_goesToUnfulfilledNeverAllocated() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("paneer", 3, "kg")),
                List.of(quote(H, "paneer", 2000, false, null)),
                List.of(constraint(H, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(allocatedQty(a, "paneer")).isZero();
        assertThat(a.perPlatform()).isEmpty();
        assertThat(a.unfulfilled()).hasSize(1);
        assertThat(a.unfulfilled().get(0).reason()).contains("out of stock");
    }

    @Test
    void outOfStockOnCheaper_routesToInStockPlatform() {
        // H is cheaper but out of stock; the optimizer must use the in-stock platform A.
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("paneer", 3, "kg")),
                List.of(quote(H, "paneer", 2000, false, null), quote(A, "paneer", 2500, true, null)),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(qtyOn(a, "paneer", A)).isEqualTo(3);
        assertThat(qtyOn(a, "paneer", H)).isZero();
        assertThat(a.unfulfilled()).isEmpty();
    }

    @Test
    void savingComputedVsCheapestSinglePlatformBaseline() {
        // Each item is cheaper on a different platform; with zero delivery fees the split beats the
        // best single-platform basket. savingPaise = grandTotal - baseline (negative = money saved).
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("potato", 1, "kg"), item("onion", 1, "kg")),
                List.of(
                        quote(H, "potato", 1000, true, null), quote(A, "potato", 1500, true, null),
                        quote(H, "onion", 1500, true, null), quote(A, "onion", 1000, true, null)),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(a.grandTotalPaise()).isEqualTo(2000);
        assertThat(a.singlePlatformBaselinePaise()).isEqualTo(2500);
        assertThat(a.savingPaise()).isEqualTo(-500);
        assertThat(a.savingPaise()).isEqualTo(a.grandTotalPaise() - a.singlePlatformBaselinePaise());
    }

    @Test
    void everyLineHasARupeeReason() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("potato", 1, "kg"), item("onion", 10, "kg")),
                List.of(
                        quote(H, "potato", 1000, true, null), quote(A, "potato", 1500, true, null),
                        quote(H, "onion", 800, true, 6), quote(A, "onion", 900, true, null)),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(a.perPlatform()).isNotEmpty();
        for (Domain.PlatformAllocation pa : a.perPlatform()) {
            for (Domain.AllocationLine l : pa.lines()) {
                assertThat(l.reason()).contains("\u20B9"); // ₹
                assertThat(l.lineTotalPaise()).isEqualTo((long) l.qty() * l.unitPricePaise());
            }
        }
    }

    @Test
    void emptyAvailability_isGraceful() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(List.of(), List.of(), List.of());

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(a.perPlatform()).isEmpty();
        assertThat(a.grandTotalPaise()).isZero();
        assertThat(a.singlePlatformBaselinePaise()).isZero();
        assertThat(a.savingPaise()).isZero();
        assertThat(a.unfulfilled()).isEmpty();
    }

    @Test
    void itemsRequestedButNoQuotes_allUnfulfilledNoCrash() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("potato", 2, "kg"), item("onion", 1, "kg")),
                List.of(),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation a = optimizer.optimize(req);

        assertThat(a.perPlatform()).isEmpty();
        assertThat(a.unfulfilled()).hasSize(2);
        assertThat(a.grandTotalPaise()).isZero();
    }

    @Test
    void nullRequest_isGraceful() {
        Domain.Allocation a = optimizer.optimize(null);
        assertThat(a.perPlatform()).isEmpty();
        assertThat(a.unfulfilled()).isEmpty();
        assertThat(a.grandTotalPaise()).isZero();
    }

    @Test
    void deterministic_sameInputSameOutput() {
        Domain.OptimizeRequest req = new Domain.OptimizeRequest(
                List.of(item("potato", 3, "kg"), item("onion", 7, "kg")),
                List.of(
                        quote(H, "potato", 1000, true, 2), quote(A, "potato", 1100, true, null),
                        quote(H, "onion", 900, true, null), quote(A, "onion", 950, true, null)),
                List.of(constraint(H, 0, 0, null), constraint(A, 0, 0, null)));

        Domain.Allocation first = optimizer.optimize(req);
        Domain.Allocation second = optimizer.optimize(req);
        assertThat(first.grandTotalPaise()).isEqualTo(second.grandTotalPaise());
        assertThat(first.perPlatform()).hasSameSizeAs(second.perPlatform());
    }
}

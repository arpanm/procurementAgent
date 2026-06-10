package ai.procurecopilot.backend.agent;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.PlatformId;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Verifier safety-gate tests (PROCURE_COPILOT_PLAN.md §3.3, Epic 6, §9.5). The gate must pass on an
 * exact cart and block on quantity mismatch, price drift beyond tolerance, missing SKU, and any extra
 * unexpected SKU. Tolerance is the default 0.05 (5%).
 */
class VerifyServiceTest {

    private final VerifyService verifier = new VerifyService(0.05);

    private static VerifyRequest req(List<CartItem> expected, List<CartItem> actual) {
        return new VerifyRequest(PlatformId.HYPERPURE, expected, actual);
    }

    private static CartItem line(String sku, int qty, long price) {
        return new CartItem(sku, qty, price);
    }

    @Test
    void exactMatchPasses() {
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-onion", 10, 5000), line("hp-paneer", 2, 18000)),
                List.of(line("hp-onion", 10, 5000), line("hp-paneer", 2, 18000))));
        assertThat(r.ok()).isTrue();
        assertThat(r.mismatches()).isEmpty();
    }

    @Test
    void priceWithinTolerancePasses() {
        // 5000 paise expected, 5% tolerance = 250 paise allowed; 5240 drift 240 ≤ 250 → ok.
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-onion", 10, 5000)),
                List.of(line("hp-onion", 10, 5240))));
        assertThat(r.ok()).isTrue();
    }

    @Test
    void quantityMismatchBlocks() {
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-onion", 10, 5000)),
                List.of(line("hp-onion", 8, 5000))));
        assertThat(r.ok()).isFalse();
        assertThat(r.mismatches()).hasSize(1);
        assertThat(r.mismatches().get(0)).contains("Quantity mismatch", "hp-onion", "10", "8");
    }

    @Test
    void priceBeyondToleranceBlocks() {
        // 5000 expected, allowed 250; 5300 drift 300 > 250 → block.
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-onion", 10, 5000)),
                List.of(line("hp-onion", 10, 5300))));
        assertThat(r.ok()).isFalse();
        assertThat(r.mismatches()).anySatisfy(m ->
                assertThat(m).contains("Price drift", "hp-onion"));
    }

    @Test
    void missingSkuBlocks() {
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-onion", 10, 5000), line("hp-paneer", 2, 18000)),
                List.of(line("hp-onion", 10, 5000))));
        assertThat(r.ok()).isFalse();
        assertThat(r.mismatches()).anySatisfy(m ->
                assertThat(m).contains("Missing SKU", "hp-paneer"));
    }

    @Test
    void extraUnexpectedSkuBlocks() {
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-onion", 10, 5000)),
                List.of(line("hp-onion", 10, 5000), line("hp-chips", 1, 4000))));
        assertThat(r.ok()).isFalse();
        assertThat(r.mismatches()).anySatisfy(m ->
                assertThat(m).contains("Unexpected SKU", "hp-chips"));
    }

    @Test
    void exactBoundaryDriftPasses() {
        // 10000 expected, allowed exactly 500; 10500 drift 500 == allowed → still ok (strict >).
        VerifyResponse r = verifier.verify(req(
                List.of(line("hp-oil", 1, 10000)),
                List.of(line("hp-oil", 1, 10500))));
        assertThat(r.ok()).isTrue();
    }
}

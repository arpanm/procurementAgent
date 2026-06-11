package ai.procurecopilot.backend.agent;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.Domain;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Planner normalization tests (PROCURE_COPILOT_PLAN.md §3.3, Epic 1). */
class PlanServiceTest {

    private final PlanService planService = new PlanService();

    @Test
    void alwaysReturnsBothMvpPlatformsAsWireStrings() {
        PlanResponse r = planService.plan(new PlanRequest("anything", List.of()));
        assertThat(r.platforms()).containsExactly("hyperpure", "amazon");
    }

    @Test
    void dedupesSameItemAndUnitBySummingQty() {
        PlanResponse r = planService.plan(new PlanRequest("order", List.of(
                new Domain.RequestedItem("potato", "potato", 2, "kg"),
                new Domain.RequestedItem("potato", "potato", 3, "kg"),
                new Domain.RequestedItem("onion", "onion", 1, "kg"))));

        assertThat(r.normalizedItems()).hasSize(2);
        Domain.RequestedItem potato = r.normalizedItems().get(0);
        assertThat(potato.canonicalItemId()).isEqualTo("potato");
        assertThat(potato.qty()).isEqualTo(5);
        assertThat(r.normalizedItems().get(1).canonicalItemId()).isEqualTo("onion");
    }

    @Test
    void preservesBrandVariantAndPackSizeThroughNormalization() {
        PlanResponse r = planService.plan(new PlanRequest("order", List.of(
                new Domain.RequestedItem("paneer", "paneer", 5, "packet",
                        "Milky Mist", null, "500 g"))));

        Domain.RequestedItem paneer = r.normalizedItems().get(0);
        assertThat(paneer.brand()).isEqualTo("Milky Mist");
        assertThat(paneer.packSize()).isEqualTo("500 g");
        assertThat(paneer.qty()).isEqualTo(5);
        assertThat(paneer.unit()).isEqualTo("packet");
    }

    @Test
    void keepsFirstSeenRefinementsWhenMergingQuantities() {
        PlanResponse r = planService.plan(new PlanRequest("order", List.of(
                new Domain.RequestedItem("paneer", "paneer", 2, "packet",
                        "Milky Mist", null, "500 g"),
                new Domain.RequestedItem("paneer", "paneer", 3, "packet",
                        "Amul", null, "200 g"))));

        assertThat(r.normalizedItems()).hasSize(1);
        Domain.RequestedItem paneer = r.normalizedItems().get(0);
        assertThat(paneer.qty()).isEqualTo(5);
        assertThat(paneer.brand()).isEqualTo("Milky Mist");
        assertThat(paneer.packSize()).isEqualTo("500 g");
    }

    @Test
    void differentUnitsAreNotMerged() {
        PlanResponse r = planService.plan(new PlanRequest("order", List.of(
                new Domain.RequestedItem("potato", "potato", 2, "kg"),
                new Domain.RequestedItem("potato", "potato", 1, "packet"))));
        assertThat(r.normalizedItems()).hasSize(2);
    }

    @Test
    void canonicalizesIdsAndNames() {
        PlanResponse r = planService.plan(new PlanRequest("order", List.of(
                new Domain.RequestedItem("  Potato  ", "Aloo", 2, "KG"))));
        Domain.RequestedItem it = r.normalizedItems().get(0);
        assertThat(it.canonicalItemId()).isEqualTo("potato");
        assertThat(it.unit()).isEqualTo("kg");
        assertThat(it.qty()).isEqualTo(2);
    }

    @Test
    void derivesCanonicalIdFromNameWhenIdMissing() {
        PlanResponse r = planService.plan(new PlanRequest("order", List.of(
                new Domain.RequestedItem(null, "Refined Oil", 1, "carton"))));
        assertThat(r.normalizedItems().get(0).canonicalItemId()).isEqualTo("refinedoil");
    }

    @Test
    void dropsZeroQtyAndNullItems() {
        PlanResponse r = planService.plan(new PlanRequest("order", java.util.Arrays.asList(
                new Domain.RequestedItem("potato", "potato", 0, "kg"),
                null,
                new Domain.RequestedItem("onion", "onion", 2, "kg"))));
        assertThat(r.normalizedItems()).hasSize(1);
        assertThat(r.normalizedItems().get(0).canonicalItemId()).isEqualTo("onion");
    }

    @Test
    void nullRequestIsGraceful() {
        PlanResponse r = planService.plan(null);
        assertThat(r.normalizedItems()).isEmpty();
        assertThat(r.platforms()).containsExactly("hyperpure", "amazon");
    }
}

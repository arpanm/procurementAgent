package ai.procurecopilot.backend.playbook;

import static org.assertj.core.api.Assertions.assertThat;

import ai.procurecopilot.backend.common.PlatformId;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Playbook registry tests (PROCURE_COPILOT_PLAN.md §3.5.7, Epic 0/3): seeded for both platforms, get
 * by flow, and shadow-mode upsert where a newer version wins and an older one cannot clobber it.
 */
class PlaybookRegistryTest {

    @Test
    void seededWithBothPlatformsAndCoreFlows() {
        PlaybookRegistry registry = new PlaybookRegistry();

        List<Playbook> hyperpure = registry.get(PlatformId.HYPERPURE);
        List<Playbook> amazon = registry.get(PlatformId.AMAZON);

        assertThat(hyperpure).extracting(Playbook::flow)
                .contains("search", "readProduct", "addToCart", "checkout");
        assertThat(amazon).extracting(Playbook::flow)
                .contains("search", "readProduct", "addToCart", "checkout");
        assertThat(registry.list()).hasSize(hyperpure.size() + amazon.size());
    }

    @Test
    void getByFlowReturnsTheMatchingPlaybook() {
        PlaybookRegistry registry = new PlaybookRegistry();
        assertThat(registry.get(PlatformId.HYPERPURE, "search"))
                .hasValueSatisfying(p -> {
                    assertThat(p.platform()).isEqualTo(PlatformId.HYPERPURE);
                    assertThat(p.flow()).isEqualTo("search");
                });
        assertThat(registry.get(PlatformId.AMAZON, "nope")).isEmpty();
    }

    @Test
    void upsertPromotesNewerVersionAndRejectsOlder() {
        PlaybookRegistry registry = new PlaybookRegistry();
        List<Map<String, Object>> steps = List.of(Map.of("action", "click", "selector", "#cart"));

        Playbook v2 = registry.register(new Playbook(PlatformId.HYPERPURE, "search", 2, steps));
        assertThat(v2.version()).isEqualTo(2);
        assertThat(registry.get(PlatformId.HYPERPURE, "search")).hasValueSatisfying(p ->
                assertThat(p.version()).isEqualTo(2));

        // An older candidate must not clobber the promoted v2.
        Playbook stillV2 = registry.register(new Playbook(PlatformId.HYPERPURE, "search", 1, steps));
        assertThat(stillV2.version()).isEqualTo(2);
    }

    @Test
    void upsertRegistersBrandNewFlow() {
        PlaybookRegistry registry = new PlaybookRegistry();
        registry.register(new Playbook(PlatformId.AMAZON, "reorder", 1, List.of()));
        assertThat(registry.get(PlatformId.AMAZON, "reorder")).isPresent();
    }
}

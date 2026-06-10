package ai.procurecopilot.backend.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import org.junit.jupiter.api.Test;

/**
 * Event-store tests (PROCURE_COPILOT_PLAN.md §3.6.4, Epic 0/5/6): monotonic seq on append, a
 * latest-state projection, idempotent dedupe by clientEventId, and 404-style failure for unknown ids.
 */
class SessionStoreTest {

    private final SessionStore store = new SessionStore();

    @Test
    void appendAssignsMonotonicSeq() {
        String id = store.createSession();
        SessionEvent e0 = store.append(id, "PlanCreated", Map.of("items", 2));
        SessionEvent e1 = store.append(id, "QuoteRead", Map.of("platform", "hyperpure"));
        SessionEvent e2 = store.append(id, "ItemAddedToCart", Map.of("sku", "hp-onion"));

        assertThat(e0.seq()).isEqualTo(0);
        assertThat(e1.seq()).isEqualTo(1);
        assertThat(e2.seq()).isEqualTo(2);
        assertThat(store.events(id)).extracting(SessionEvent::seq).containsExactly(0L, 1L, 2L);
    }

    @Test
    void projectionFoldsLatestStateAndMeta() {
        String id = store.createSession();
        store.append(id, "PlanCreated", Map.of("status", "planning", "items", 3));
        store.append(id, "Approved", Map.of("status", "approved"));

        Map<String, Object> projection = store.projection(id);
        // Later event overrides earlier for the same key.
        assertThat(projection).containsEntry("status", "approved");
        assertThat(projection).containsEntry("items", 3);
        assertThat(projection).containsEntry("eventCount", 2);
        assertThat(projection).containsEntry("lastSeq", 1L);
        assertThat(projection).containsEntry("lastType", "Approved");
    }

    @Test
    void emptySessionProjectionIsJustMeta() {
        String id = store.createSession();
        assertThat(store.projection(id)).containsEntry("eventCount", 0);
        assertThat(store.events(id)).isEmpty();
    }

    @Test
    void dedupeByClientEventIdReturnsPriorEventWithoutAppending() {
        String id = store.createSession();
        SessionEvent first = store.append(id, "ItemAddedToCart", Map.of("sku", "hp-onion"), "evt-1");
        SessionEvent retry = store.append(id, "ItemAddedToCart", Map.of("sku", "hp-onion"), "evt-1");

        assertThat(retry).isEqualTo(first);
        assertThat(retry.seq()).isEqualTo(first.seq());
        assertThat(store.events(id)).hasSize(1);

        // A different clientEventId is a genuinely new event.
        store.append(id, "ItemAddedToCart", Map.of("sku", "hp-paneer"), "evt-2");
        assertThat(store.events(id)).hasSize(2);
    }

    @Test
    void unknownSessionThrows() {
        assertThatThrownBy(() -> store.events("nope")).isInstanceOf(NoSuchElementException.class);
        assertThatThrownBy(() -> store.append("nope", "x", Map.of()))
                .isInstanceOf(NoSuchElementException.class);
    }

    @Test
    void subscribeReturnsEmitterForKnownSessionAndThrowsForUnknown() {
        String id = store.createSession();
        assertThat(store.subscribe(id)).isNotNull();
        assertThatThrownBy(() -> store.subscribe("nope")).isInstanceOf(NoSuchElementException.class);
    }

    @Test
    void nullPayloadAppendIsTolerated() {
        String id = store.createSession();
        SessionEvent e = store.append(id, "Noop", null);
        assertThat(e.payload()).isEmpty();
        assertThat((List<SessionEvent>) store.events(id)).hasSize(1);
    }
}

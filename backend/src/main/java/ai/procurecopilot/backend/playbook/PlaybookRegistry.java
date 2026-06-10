package ai.procurecopilot.backend.playbook;

import ai.procurecopilot.backend.common.PlatformId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/**
 * In-memory playbook registry (PROCURE_COPILOT_PLAN.md §3.5.7, Epic 0/3). Holds the deterministic
 * per-platform flows so a selector fix ships without an app release. Seeded with placeholders for both
 * MVP platforms; supports upsert for shadow-mode promotion (a newer-or-equal version wins). Thread-safe
 * via {@link ConcurrentHashMap} keyed by platform then flow.
 */
@Service
public class PlaybookRegistry {

    private static final List<String> SEED_FLOWS =
            List.of("search", "readProduct", "addToCart", "checkout");

    private final Map<PlatformId, Map<String, Playbook>> byPlatform = new ConcurrentHashMap<>();

    public PlaybookRegistry() {
        for (PlatformId platform : PlatformId.values()) {
            for (String flow : SEED_FLOWS) {
                register(placeholder(platform, flow));
            }
        }
    }

    /** All playbooks for a platform (empty list if none / unknown). */
    public List<Playbook> get(PlatformId platform) {
        Map<String, Playbook> flows = byPlatform.get(platform);
        return flows == null ? List.of() : new ArrayList<>(flows.values());
    }

    /** A specific flow's playbook for a platform. */
    public Optional<Playbook> get(PlatformId platform, String flow) {
        Map<String, Playbook> flows = byPlatform.get(platform);
        if (flows == null || flow == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(flows.get(flow));
    }

    /** Every registered playbook across all platforms. */
    public List<Playbook> list() {
        List<Playbook> all = new ArrayList<>();
        for (Map<String, Playbook> flows : byPlatform.values()) {
            all.addAll(flows.values());
        }
        return all;
    }

    /**
     * Upsert a candidate playbook (shadow-mode promotion). The incoming playbook is stored unless an
     * existing entry has a strictly higher version, so an older candidate can never clobber a promoted
     * one. Returns the playbook that is now in effect for that (platform, flow).
     */
    public Playbook register(Playbook candidate) {
        if (candidate == null) {
            throw new IllegalArgumentException("playbook is required");
        }
        Map<String, Playbook> flows =
                byPlatform.computeIfAbsent(candidate.platform(), p -> new ConcurrentHashMap<>());
        return flows.merge(candidate.flow(), candidate,
                (existing, incoming) -> incoming.version() >= existing.version() ? incoming : existing);
    }

    private static Playbook placeholder(PlatformId platform, String flow) {
        // Opaque placeholder step so the flow is non-empty; the device records real selectors later.
        Map<String, Object> step = Map.of(
                "action", "placeholder",
                "note", "seed playbook for " + platform.wire() + " " + flow);
        return new Playbook(platform, flow, 1, List.of(step));
    }
}

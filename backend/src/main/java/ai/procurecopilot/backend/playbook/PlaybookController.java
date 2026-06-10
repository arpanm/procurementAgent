package ai.procurecopilot.backend.playbook;

import ai.procurecopilot.backend.common.PlatformId;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Playbook registry endpoints (PROCURE_COPILOT_PLAN.md §3.5.7, §3.6.7, Epic 3). The {@code platform}
 * path variable is the lowercase wire string ("hyperpure" / "amazon").
 */
@RestController
public class PlaybookController {

    private final PlaybookRegistry registry;

    public PlaybookController(PlaybookRegistry registry) {
        this.registry = registry;
    }

    @GetMapping("/playbooks/{platform}")
    public List<Playbook> byPlatform(@PathVariable String platform) {
        return registry.get(parse(platform));
    }

    @GetMapping("/playbooks/{platform}/{flow}")
    public Playbook byFlow(@PathVariable String platform, @PathVariable String flow) {
        return registry.get(parse(platform), flow)
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "No playbook for " + platform + "/" + flow));
    }

    @PostMapping("/playbooks/{platform}")
    public Playbook upsert(
            @PathVariable String platform, @RequestBody PlaybookUpsertRequest request) {
        if (request == null || request.flow() == null || request.flow().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "flow is required");
        }
        Playbook candidate =
                new Playbook(parse(platform), request.flow(), request.version(), request.steps());
        return registry.register(candidate);
    }

    private static PlatformId parse(String wire) {
        try {
            return PlatformId.fromWire(wire);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown platform: " + wire);
        }
    }
}

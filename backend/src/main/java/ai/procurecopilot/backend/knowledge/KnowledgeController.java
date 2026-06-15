package ai.procurecopilot.backend.knowledge;

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
 * Guided-RAG knowledge endpoints (PROCURE_COPILOT_PLAN.md guided-RAG knowledge layer). Serves
 * curated per-platform extraction policies + hints and lets the device append observations to the
 * RAG corpus. The {@code platform} path variable is the lowercase wire string ("amazon" /
 * "hyperpure").
 */
@RestController
public class KnowledgeController {

    private final KnowledgeService service;

    public KnowledgeController(KnowledgeService service) {
        this.service = service;
    }

    @GetMapping("/knowledge")
    public List<KnowledgeDoc> all() {
        return service.list();
    }

    @GetMapping("/knowledge/{platform}")
    public KnowledgeDoc byPlatform(@PathVariable String platform) {
        return service.get(parse(platform));
    }

    @PostMapping("/knowledge/{platform}/observations")
    public KnowledgeDoc addObservation(
            @PathVariable String platform, @RequestBody ObservationRequest request) {
        if (request == null || request.kind() == null || request.kind().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "kind is required");
        }
        if (request.text() == null || request.text().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "text is required");
        }
        return service.addObservation(parse(platform), request.kind(), request.text());
    }

    private static PlatformId parse(String wire) {
        try {
            return PlatformId.fromWire(wire);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown platform: " + wire);
        }
    }
}

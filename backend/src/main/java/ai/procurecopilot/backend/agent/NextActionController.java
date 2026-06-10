package ai.procurecopilot.backend.agent;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Grounding endpoint (PROCURE_COPILOT_PLAN.md §3.5, §3.6.7, Epic 6). Body
 * {platform, task, observation, history} → ONE EngineAction JSON. The device executes the returned
 * action against the {@code data-pc-idx}-tagged element and re-observes.
 */
@RestController
public class NextActionController {

    private final GroundingService groundingService;

    public NextActionController(GroundingService groundingService) {
        this.groundingService = groundingService;
    }

    @PostMapping("/next-action")
    public JsonNode nextAction(@RequestBody NextActionRequest request) {
        return groundingService.nextAction(request);
    }
}

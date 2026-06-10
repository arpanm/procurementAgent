package ai.procurecopilot.backend.agent;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Intent / slot-extraction endpoint (PROCURE_COPILOT_PLAN.md Epic 1). Body {text, locale?} →
 * {items, confidence}.
 */
@RestController
public class IntentController {

    private final IntentService intentService;

    public IntentController(IntentService intentService) {
        this.intentService = intentService;
    }

    @PostMapping("/intent")
    public IntentResponse intent(@RequestBody IntentRequest request) {
        String text = request == null ? null : request.text();
        String locale = request == null ? null : request.locale();
        IntentService.IntentResult result = intentService.parse(text, locale);
        return new IntentResponse(result.items(), result.confidence());
    }
}

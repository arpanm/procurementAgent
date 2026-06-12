package ai.procurecopilot.backend.agent;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Intent / slot-extraction endpoint (PROCURE_COPILOT_PLAN.md Epic 1). Body {text, locale?} →
 * {items, confidence}.
 */
@RestController
public class IntentController {

    private static final Logger log = LoggerFactory.getLogger(IntentController.class);

    private final IntentService intentService;

    public IntentController(IntentService intentService) {
        this.intentService = intentService;
    }

    @PostMapping("/intent")
    public IntentResponse intent(@RequestBody IntentRequest request) {
        String text = request == null ? null : request.text();
        String locale = request == null ? null : request.locale();
        IntentService.IntentResult result = intentService.parse(text, locale);
        // Log the exact text in and the parsed items out, so a wrong on-device search ("milky" instead of
        // "paneer") can be traced to THIS parse rather than guessed at. Text here is already device-scrubbed.
        log.info("/intent text={} → confidence={} items={}", text, result.confidence(),
                result.items().stream()
                        .map(i -> i.name() + "[brand=" + i.brand() + ",variant=" + i.variant()
                                + ",pack=" + i.packSize() + ",qty=" + i.qty() + "]")
                        .toList());
        return new IntentResponse(result.items(), result.confidence());
    }
}

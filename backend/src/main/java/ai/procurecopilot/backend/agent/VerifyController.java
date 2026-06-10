package ai.procurecopilot.backend.agent;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Verifier endpoint (PROCURE_COPILOT_PLAN.md §3.3, Epic 6). Body {platform, expected, actual} →
 * {ok, mismatches}. The device calls this before checkout; a non-ok result must block the order.
 */
@RestController
public class VerifyController {

    private final VerifyService verifyService;

    public VerifyController(VerifyService verifyService) {
        this.verifyService = verifyService;
    }

    @PostMapping("/verify")
    public VerifyResponse verify(@RequestBody VerifyRequest request) {
        return verifyService.verify(request);
    }
}

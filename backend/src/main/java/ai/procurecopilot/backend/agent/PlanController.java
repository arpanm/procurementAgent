package ai.procurecopilot.backend.agent;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Planning endpoint (PROCURE_COPILOT_PLAN.md §3.6.7, Epic 1). Body {requestText, items} →
 * {normalizedItems, platforms} with lowercase wire platform ids.
 */
@RestController
public class PlanController {

    private final PlanService planService;

    public PlanController(PlanService planService) {
        this.planService = planService;
    }

    @PostMapping("/plan")
    public PlanResponse plan(@RequestBody PlanRequest request) {
        return planService.plan(request);
    }
}

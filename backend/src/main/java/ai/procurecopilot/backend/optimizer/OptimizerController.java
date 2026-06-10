package ai.procurecopilot.backend.optimizer;

import ai.procurecopilot.backend.common.Domain;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Optimizer endpoint (PROCURE_COPILOT_PLAN.md §3.6.7, Epic 4). The device posts demand + live quotes
 * + per-platform constraints and receives an explainable rupee allocation. Pure and deterministic —
 * no LLM call on this path.
 */
@RestController
public class OptimizerController {

    private final Optimizer optimizer;

    public OptimizerController(Optimizer optimizer) {
        this.optimizer = optimizer;
    }

    @PostMapping("/optimize")
    public Domain.Allocation optimize(@RequestBody Domain.OptimizeRequest request) {
        return optimizer.optimize(request);
    }
}

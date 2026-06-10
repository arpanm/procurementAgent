package ai.procurecopilot.backend.optimizer;

import ai.procurecopilot.backend.common.Domain;

/**
 * The cart-split optimizer (PROCURE_COPILOT_PLAN.md §4). Given demand, live quotes and per-platform
 * commercial constraints, it produces an explainable {@link Domain.Allocation} that minimises total
 * landed cost subject to availability, stock caps, minimum-order-value, delivery-fee and credit
 * limits.
 *
 * <p>MVP ships a deterministic greedy heuristic ({@link GreedyOptimizer}); a CP-SAT solver can later
 * slot in behind this same contract without touching callers.
 */
public interface Optimizer {

    /** Allocate the request deterministically. Must never call out to an LLM. */
    Domain.Allocation optimize(Domain.OptimizeRequest req);
}

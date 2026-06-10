package ai.procurecopilot.backend.agent;

/**
 * One cart/plan line in a verify request (PROCURE_COPILOT_PLAN.md §3.3). Money is integer paise. Used
 * for both the approved plan ({@code expected}) and the live cart read-back ({@code actual}).
 */
public record CartItem(String skuId, int qty, long unitPricePaise) {
}

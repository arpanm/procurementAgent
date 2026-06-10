package ai.procurecopilot.backend.common;

/**
 * Platforms supported in the MVP (PROCURE_COPILOT_PLAN.md §1). Extension to more platforms is
 * additive and does not change the optimizer, HITL or audit layers (§10).
 */
public enum PlatformId {
    HYPERPURE,
    AMAZON;

    public String wire() {
        return name().toLowerCase();
    }

    public static PlatformId fromWire(String value) {
        return PlatformId.valueOf(value.trim().toUpperCase());
    }
}

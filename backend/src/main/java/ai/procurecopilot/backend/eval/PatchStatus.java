package ai.procurecopilot.backend.eval;

/**
 * Lifecycle of a gated knowledge patch (a removal or policy flip the eval pipeline will not
 * auto-apply): {@code PENDING} awaits a human verdict, {@code PROMOTED} was applied to the live doc,
 * {@code REJECTED} was discarded.
 */
public enum PatchStatus {
    PENDING,
    PROMOTED,
    REJECTED
}

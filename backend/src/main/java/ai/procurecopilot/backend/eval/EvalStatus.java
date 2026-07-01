package ai.procurecopilot.backend.eval;

/**
 * Outcome of an eval run: {@code SUCCESS} applied and/or staged at least one change, {@code NOOP} ran
 * cleanly but the model proposed nothing actionable, {@code ERROR} failed before producing a verdict.
 */
public enum EvalStatus {
    SUCCESS,
    NOOP,
    ERROR
}

package ai.procurecopilot.backend.eval;

/**
 * Outcome of an eval run: {@code RUNNING} is a persisted claim written before the (slow) model call so a
 * concurrent repeating-failure trigger is deduped; {@code SUCCESS} applied and/or staged at least one
 * change; {@code NOOP} ran cleanly but the model proposed nothing actionable; {@code ERROR} failed
 * before producing a verdict.
 */
public enum EvalStatus {
    RUNNING,
    SUCCESS,
    NOOP,
    ERROR
}

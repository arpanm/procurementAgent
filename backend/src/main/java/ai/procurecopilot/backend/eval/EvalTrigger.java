package ai.procurecopilot.backend.eval;

/**
 * What kicked off a guided-RAG eval run: the once-a-day scheduled sweep, an explicit manual trigger,
 * or the rate-limited reaction to a repeating on-device failure (at most one per signature per hour).
 */
public enum EvalTrigger {
    DAILY,
    MANUAL,
    REPEATING_FAILURE
}

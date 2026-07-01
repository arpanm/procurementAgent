package ai.procurecopilot.backend.eval;

/**
 * The on-device failure report payload (the body of {@code POST /eval/{platform}/failures}). Mirrors
 * the device-side {@code FailureReport} byte-for-byte: the {@code flow} that failed, a {@code
 * signature} the device dedupes on (typically the SKU), the human {@code reason}, and best-effort
 * page evidence (URL, a bounded DOM digest, an optional screenshot). {@code at} is the device's ISO
 * capture time; the server still stamps its own {@code createdAt} for reliable windowing.
 */
public record FailureIngest(
        String flow,
        String signature,
        String reason,
        String url,
        String domDigest,
        String screenshotBase64,
        String skuId,
        String itemName,
        String at) {}

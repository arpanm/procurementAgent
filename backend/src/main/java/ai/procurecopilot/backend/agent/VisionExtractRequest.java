package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.common.PlatformId;

/**
 * Screenshot-based product read (PROCURE_COPILOT_PLAN.md §3.5). For SPA listings (Hyperpure) whose
 * DOM is too large to serialize over the WebView bridge reliably, the device sends a viewport
 * screenshot plus the requested item; Claude reads the best-matching product's title/price from the
 * image. {@code imageBase64} is the raw base64 PNG payload (no {@code data:} prefix).
 */
public record VisionExtractRequest(
        PlatformId platform, Domain.RequestedItem item, String imageBase64, String mimeType) {
}

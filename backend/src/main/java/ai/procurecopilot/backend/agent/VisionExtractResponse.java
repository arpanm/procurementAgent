package ai.procurecopilot.backend.agent;

/**
 * Result of a screenshot product read. Field names match the device's {@code QuoteDraft} so the app
 * can map it directly. When {@code found} is false (no matching product with a readable price was
 * visible) the device keeps the item unsourced rather than inventing a price.
 */
public record VisionExtractResponse(
        boolean found,
        String skuId,
        String title,
        Long pricePaise,
        Long mrpPaise,
        boolean inStock) {

    public static VisionExtractResponse notFound() {
        return new VisionExtractResponse(false, null, null, null, null, false);
    }
}

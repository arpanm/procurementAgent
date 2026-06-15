package ai.procurecopilot.backend.agent;

import java.util.List;

/**
 * Result of a screenshot product read. The scalar fields ({@code skuId}/{@code title}/{@code
 * pricePaise}/...) mirror the device's {@code QuoteDraft} and carry the TOP-ranked candidate so older
 * callers keep working unchanged. {@code candidates} is the full ranked top-N list (best first) the
 * device uses to offer an in-app "choose a nearby SKU" picker when there is no exact brand+size match.
 * When {@code found} is false (no matching product with a readable price was visible) the device keeps
 * the item unsourced rather than inventing a price.
 */
public record VisionExtractResponse(
        boolean found,
        String skuId,
        String title,
        Long pricePaise,
        Long mrpPaise,
        boolean inStock,
        List<Candidate> candidates) {

    /** One ranked product read off the screenshot (title + price), best-first within the response. */
    public record Candidate(
            String skuId, String title, Long pricePaise, Long mrpPaise, boolean inStock) {
    }

    public static VisionExtractResponse notFound() {
        return new VisionExtractResponse(false, null, null, null, null, false, List.of());
    }

    /** Build a response from a ranked candidate list; the first candidate seeds the scalar fields. */
    public static VisionExtractResponse of(List<Candidate> ranked) {
        if (ranked == null || ranked.isEmpty()) {
            return notFound();
        }
        Candidate top = ranked.get(0);
        return new VisionExtractResponse(
                true, top.skuId(), top.title(), top.pricePaise(), top.mrpPaise(), top.inStock(),
                List.copyOf(ranked));
    }
}

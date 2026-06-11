package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Reads the best-matching product (title + price) from a webview screenshot using Claude vision
 * (PROCURE_COPILOT_PLAN.md §3.5). This is the fallback read path for SPA listings whose serialized
 * DOM is too large to ship over the WebView bridge — the page renders fine, so a screenshot carries
 * the price reliably where the DOM does not. Output is parsed defensively into a {@link
 * VisionExtractResponse}; any malformed completion degrades to {@code not found} so the device simply
 * leaves the item unsourced (never invents a price).
 */
@Service
public class VisionExtractService {

    private static final String SYSTEM = """
            You read ONE best-matching product from a screenshot of a grocery/B2B shopping app's search
            results or product page. Reply with EXACTLY ONE JSON object, no prose:
            {"found":true|false,"title":string,"pricePaise":integer,"mrpPaise":integer|null,
            "inStock":true|false}. pricePaise is the pack/selling price in PAISE (multiply rupees by
            100; e.g. ₹658 -> 65800). Choose the product tile that best matches the requested item by
            name/brand/variant/pack size. Prefer the prominent selling price, not the per-kg unit
            price. If no matching product with a readable price is visible, reply {"found":false}.""";

    private static final Logger log = LoggerFactory.getLogger(VisionExtractService.class);

    private final ClaudeService claude;
    private final ObjectMapper mapper;

    public VisionExtractService(ClaudeService claude, ObjectMapper mapper) {
        this.claude = claude;
        this.mapper = mapper;
    }

    public VisionExtractResponse extract(VisionExtractRequest request) {
        if (request == null || request.imageBase64() == null || request.imageBase64().isBlank()
                || request.item() == null) {
            log.info("vision-extract: missing image/item -> notFound");
            return VisionExtractResponse.notFound();
        }
        String userJson = serializeItem(request);
        String mediaType = request.mimeType() == null || request.mimeType().isBlank()
                ? "image/png"
                : request.mimeType();
        log.info("vision-extract: item={} mime={} base64Len={}",
                request.item().name(), mediaType, request.imageBase64().length());
        String raw;
        try {
            raw = claude.complete(new ClaudeRequest(
                    "vision-extract", SYSTEM, userJson, 700, request.imageBase64(), mediaType));
        } catch (RuntimeException e) {
            log.warn("vision-extract: Claude call failed: {}", e.getMessage(), e);
            return VisionExtractResponse.notFound();
        }
        log.info("vision-extract: raw completion = {}", raw);
        return parse(raw);
    }

    private String serializeItem(VisionExtractRequest request) {
        Domain.RequestedItem item = request.item();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("platform", request.platform() == null ? null : request.platform().wire());
        payload.put("name", item.name());
        payload.put("brand", item.brand());
        payload.put("variant", item.variant());
        payload.put("packSize", item.packSize());
        try {
            return "Requested item: " + mapper.writeValueAsString(payload);
        } catch (Exception e) {
            return "Requested item: " + item.name();
        }
    }

    /** Defensively parse the model completion into a response, or {@code not found}. */
    VisionExtractResponse parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return VisionExtractResponse.notFound();
        }
        int start = raw.indexOf('{');
        int end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return VisionExtractResponse.notFound();
        }
        try {
            JsonNode node = mapper.readTree(raw.substring(start, end + 1));
            if (!node.isObject() || !node.path("found").asBoolean(false)) {
                return VisionExtractResponse.notFound();
            }
            JsonNode price = node.get("pricePaise");
            if (price == null || !price.canConvertToLong() || price.asLong() <= 0) {
                return VisionExtractResponse.notFound();
            }
            String title = node.path("title").asText("").trim();
            if (title.isEmpty()) {
                return VisionExtractResponse.notFound();
            }
            Long mrp = node.has("mrpPaise") && node.get("mrpPaise").canConvertToLong()
                    ? node.get("mrpPaise").asLong()
                    : null;
            boolean inStock = node.path("inStock").asBoolean(true);
            return new VisionExtractResponse(true, slug(title), title, price.asLong(), mrp, inStock);
        } catch (Exception e) {
            return VisionExtractResponse.notFound();
        }
    }

    /** Stable SKU id from a title (no href is available from a screenshot). */
    private static String slug(String title) {
        String s = title.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-+|-+$)", "");
        if (s.length() > 64) {
            s = s.substring(0, 64);
        }
        return s.isEmpty() ? "vision-sku" : s;
    }
}

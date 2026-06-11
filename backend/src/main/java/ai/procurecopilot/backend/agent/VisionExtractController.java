package ai.procurecopilot.backend.agent;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Screenshot product-read endpoint (PROCURE_COPILOT_PLAN.md §3.5). Body
 * {platform, item, imageBase64, mimeType} → {found, skuId, title, pricePaise, mrpPaise, inStock}.
 * Used by the device as a fallback when DOM serialization can't deliver a usable listing snapshot.
 */
@RestController
public class VisionExtractController {

    private final VisionExtractService visionExtractService;

    public VisionExtractController(VisionExtractService visionExtractService) {
        this.visionExtractService = visionExtractService;
    }

    @PostMapping("/vision/extract")
    public VisionExtractResponse extract(@RequestBody VisionExtractRequest request) {
        return visionExtractService.extract(request);
    }
}

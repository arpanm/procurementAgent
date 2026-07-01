package ai.procurecopilot.backend.eval;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * One on-device failure observation in the eval observability corpus. The device POSTs these when a
 * flow step (e.g. add-to-cart) fails; each carries enough to diagnose it later — the {@code flow},
 * a {@code signature} (the stable key the device dedupes on, typically the SKU), the human {@code
 * reason}, and best-effort page evidence (URL, a bounded DOM digest, an optional screenshot). The
 * {@code consumed} flag marks logs already folded into an eval run so a run never re-processes them.
 */
@Entity
@Table(
        name = "failure_log",
        indexes = {
            @Index(name = "idx_failure_platform_created", columnList = "platform,created_at"),
            @Index(name = "idx_failure_platform_signature", columnList = "platform,signature")
        })
public class FailureLogEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(length = 32, nullable = false)
    private String platform;

    @Column(nullable = false)
    private String flow;

    @Column(nullable = false)
    private String signature;

    @Column(length = 2000)
    private String reason;

    @Column(length = 2000)
    private String url;

    @Lob
    @Column(name = "dom_digest")
    private String domDigest;

    @Lob
    @Column(name = "screenshot_base64")
    private String screenshotBase64;

    @Column(name = "sku_id")
    private String skuId;

    @Column(name = "item_name")
    private String itemName;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(nullable = false)
    private boolean consumed;

    protected FailureLogEntity() {}

    public FailureLogEntity(
            String platform,
            String flow,
            String signature,
            String reason,
            String url,
            String domDigest,
            String screenshotBase64,
            String skuId,
            String itemName,
            Instant createdAt) {
        this.platform = platform;
        this.flow = flow;
        this.signature = signature;
        this.reason = reason;
        this.url = url;
        this.domDigest = domDigest;
        this.screenshotBase64 = screenshotBase64;
        this.skuId = skuId;
        this.itemName = itemName;
        this.createdAt = createdAt;
        this.consumed = false;
    }

    public Long getId() {
        return id;
    }

    public String getPlatform() {
        return platform;
    }

    public String getFlow() {
        return flow;
    }

    public String getSignature() {
        return signature;
    }

    public String getReason() {
        return reason;
    }

    public String getUrl() {
        return url;
    }

    public String getDomDigest() {
        return domDigest;
    }

    public String getScreenshotBase64() {
        return screenshotBase64;
    }

    public String getSkuId() {
        return skuId;
    }

    public String getItemName() {
        return itemName;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public boolean isConsumed() {
        return consumed;
    }

    public void markConsumed() {
        this.consumed = true;
    }
}

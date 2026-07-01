package ai.procurecopilot.backend.eval;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * A risky knowledge change the eval pipeline declined to auto-apply (a token removal or a policy
 * flip) and parked for human review — the "manual promotion" half of the hybrid-by-risk apply
 * policy. {@code kind} names the change class, {@code description} is the human rationale, and {@code
 * patchJson} is the machine-applicable delta promoted verbatim onto the live doc if accepted.
 */
@Entity
@Table(
        name = "pending_patch",
        indexes = @Index(name = "idx_pending_platform_status", columnList = "platform,status"))
public class PendingPatchEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(length = 32, nullable = false)
    private String platform;

    @Column(name = "eval_run_id")
    private Long evalRunId;

    @Column(nullable = false)
    private String kind;

    @Lob
    private String description;

    @Lob
    @Column(name = "patch_json", nullable = false)
    private String patchJson;

    @Enumerated(EnumType.STRING)
    @Column(length = 16, nullable = false)
    private PatchStatus status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    protected PendingPatchEntity() {}

    public PendingPatchEntity(
            String platform,
            Long evalRunId,
            String kind,
            String description,
            String patchJson,
            Instant createdAt) {
        this.platform = platform;
        this.evalRunId = evalRunId;
        this.kind = kind;
        this.description = description;
        this.patchJson = patchJson;
        this.createdAt = createdAt;
        this.status = PatchStatus.PENDING;
    }

    public Long getId() {
        return id;
    }

    public String getPlatform() {
        return platform;
    }

    public Long getEvalRunId() {
        return evalRunId;
    }

    public void setEvalRunId(Long evalRunId) {
        this.evalRunId = evalRunId;
    }

    public String getKind() {
        return kind;
    }

    public String getDescription() {
        return description;
    }

    public String getPatchJson() {
        return patchJson;
    }

    public PatchStatus getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getResolvedAt() {
        return resolvedAt;
    }

    public void resolve(PatchStatus status, Instant resolvedAt) {
        this.status = status;
        this.resolvedAt = resolvedAt;
    }
}

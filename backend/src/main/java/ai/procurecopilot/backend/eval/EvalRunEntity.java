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
 * The audit record for one guided-RAG eval pass over a platform's recent failures. Captures what
 * triggered it, how many failures it weighed, the resulting version bump, a human-readable {@code
 * summary} of the auto-applied changes, and the raw applied/pending patch JSON for replay. An
 * immutable history row — one per run — so the self-improvement loop is fully observable.
 */
@Entity
@Table(
        name = "eval_run",
        indexes = @Index(name = "idx_evalrun_platform_started", columnList = "platform,started_at"))
public class EvalRunEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(length = 32, nullable = false)
    private String platform;

    @Enumerated(EnumType.STRING)
    @Column(length = 24, nullable = false)
    private EvalTrigger trigger;

    @Enumerated(EnumType.STRING)
    @Column(length = 16, nullable = false)
    private EvalStatus status;

    @Column(name = "failures_considered", nullable = false)
    private int failuresConsidered;

    @Column(name = "from_version")
    private Integer fromVersion;

    @Column(name = "to_version")
    private Integer toVersion;

    @Lob
    private String summary;

    @Lob
    @Column(name = "applied_json")
    private String appliedJson;

    @Lob
    @Column(name = "pending_json")
    private String pendingJson;

    @Lob
    private String error;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    protected EvalRunEntity() {}

    public EvalRunEntity(String platform, EvalTrigger trigger, Instant startedAt) {
        this.platform = platform;
        this.trigger = trigger;
        this.startedAt = startedAt;
        this.status = EvalStatus.NOOP;
        this.failuresConsidered = 0;
    }

    public Long getId() {
        return id;
    }

    public String getPlatform() {
        return platform;
    }

    public EvalTrigger getTrigger() {
        return trigger;
    }

    public EvalStatus getStatus() {
        return status;
    }

    public int getFailuresConsidered() {
        return failuresConsidered;
    }

    public Integer getFromVersion() {
        return fromVersion;
    }

    public Integer getToVersion() {
        return toVersion;
    }

    public String getSummary() {
        return summary;
    }

    public String getAppliedJson() {
        return appliedJson;
    }

    public String getPendingJson() {
        return pendingJson;
    }

    public String getError() {
        return error;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getFinishedAt() {
        return finishedAt;
    }

    public void setStatus(EvalStatus status) {
        this.status = status;
    }

    public void setFailuresConsidered(int failuresConsidered) {
        this.failuresConsidered = failuresConsidered;
    }

    public void setVersions(Integer fromVersion, Integer toVersion) {
        this.fromVersion = fromVersion;
        this.toVersion = toVersion;
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public void setAppliedJson(String appliedJson) {
        this.appliedJson = appliedJson;
    }

    public void setPendingJson(String pendingJson) {
        this.pendingJson = pendingJson;
    }

    public void setError(String error) {
        this.error = error;
    }

    public void finish(Instant finishedAt) {
        this.finishedAt = finishedAt;
    }
}

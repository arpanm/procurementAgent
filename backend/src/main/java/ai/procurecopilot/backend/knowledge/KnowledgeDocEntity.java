package ai.procurecopilot.backend.knowledge;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * The persisted live guided-RAG knowledge document for one platform. The whole {@link KnowledgeDoc}
 * is stored as its canonical camelCase JSON in {@code docJson} (a single source of truth that
 * preserves the wire contract byte-for-byte), with {@code version} mirrored out as a column for cheap
 * querying/ordering. Seeded from {@code classpath:knowledge/{platform}.json} on first boot, then
 * mutated in place by the eval pipeline (token additions auto-applied, removals/policy-flips gated).
 */
@Entity
@Table(name = "knowledge_doc")
public class KnowledgeDocEntity {

    @Id
    @Column(length = 32)
    private String platform;

    @Column(nullable = false)
    private int version;

    @Lob
    @Column(name = "doc_json", nullable = false)
    private String docJson;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected KnowledgeDocEntity() {}

    public KnowledgeDocEntity(String platform, int version, String docJson, Instant updatedAt) {
        this.platform = platform;
        this.version = version;
        this.docJson = docJson;
        this.updatedAt = updatedAt;
    }

    public String getPlatform() {
        return platform;
    }

    public int getVersion() {
        return version;
    }

    public String getDocJson() {
        return docJson;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void update(int version, String docJson, Instant updatedAt) {
        this.version = version;
        this.docJson = docJson;
        this.updatedAt = updatedAt;
    }
}

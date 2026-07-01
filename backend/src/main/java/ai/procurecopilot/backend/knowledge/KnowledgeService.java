package ai.procurecopilot.backend.knowledge;

import ai.procurecopilot.backend.common.PlatformId;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * DB-backed guided-RAG knowledge registry (PROCURE_COPILOT_PLAN.md guided-RAG knowledge layer). The
 * live {@link KnowledgeDoc} for each platform is persisted as canonical camelCase JSON in {@link
 * KnowledgeDocEntity}, seeded once from {@code classpath:knowledge/{platform}.json} on first boot and
 * thereafter mutated in place — the device appends observations (the "RAG" learnings) and the eval
 * pipeline applies token additions / promoted patches. Persisting the whole doc keeps the wire
 * contract byte-for-byte identical to the frontend half across restarts.
 */
@Service
public class KnowledgeService {

    private final ObjectMapper mapper;
    private final KnowledgeDocRepository repo;

    public KnowledgeService(ObjectMapper mapper, KnowledgeDocRepository repo) {
        this.mapper = mapper;
        this.repo = repo;
    }

    /** Seed any platform that has no persisted doc yet from its curated classpath JSON. */
    @PostConstruct
    @Transactional
    public void seed() {
        for (PlatformId platform : PlatformId.values()) {
            if (!repo.existsById(platform.wire())) {
                repo.save(toEntity(loadSeed(platform)));
            }
        }
    }

    /** The current live doc for a platform (seeding lazily if it has never been persisted). */
    @Transactional
    public KnowledgeDoc get(PlatformId platform) {
        return fromEntity(loadOrSeed(platform));
    }

    /** Append an observation to a platform's corpus and return the updated doc. */
    @Transactional
    public KnowledgeDoc addObservation(PlatformId platform, String kind, String text) {
        KnowledgeDocEntity entity = loadOrSeed(platform);
        KnowledgeDoc current = fromEntity(entity);
        List<KnowledgeNote> notes = new ArrayList<>(current.notes());
        notes.add(new KnowledgeNote(Instant.now().toString(), kind, text));
        KnowledgeDoc updated = new KnowledgeDoc(
                current.platform(), current.version(), current.policies(), current.hints(), notes);
        entity.update(updated.version(), toJson(updated), Instant.now());
        repo.save(entity);
        return updated;
    }

    /** Persist a wholesale replacement doc (used by the eval pipeline when applying patches). */
    @Transactional
    public KnowledgeDoc save(PlatformId platform, KnowledgeDoc doc) {
        KnowledgeDocEntity entity = loadOrSeed(platform);
        entity.update(doc.version(), toJson(doc), Instant.now());
        repo.save(entity);
        return doc;
    }

    /** Every platform's current live doc. */
    @Transactional
    public List<KnowledgeDoc> list() {
        List<KnowledgeDoc> all = new ArrayList<>();
        for (PlatformId platform : PlatformId.values()) {
            all.add(get(platform));
        }
        return all;
    }

    private KnowledgeDocEntity loadOrSeed(PlatformId platform) {
        return repo.findById(platform.wire())
                .orElseGet(() -> repo.save(toEntity(loadSeed(platform))));
    }

    private KnowledgeDocEntity toEntity(KnowledgeDoc doc) {
        return new KnowledgeDocEntity(doc.platform(), doc.version(), toJson(doc), Instant.now());
    }

    private KnowledgeDoc fromEntity(KnowledgeDocEntity entity) {
        try {
            return mapper.readValue(entity.getDocJson(), KnowledgeDoc.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(
                    "Corrupt persisted knowledge doc for platform " + entity.getPlatform(), e);
        }
    }

    private String toJson(KnowledgeDoc doc) {
        try {
            return mapper.writeValueAsString(doc);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize knowledge doc", e);
        }
    }

    private KnowledgeDoc loadSeed(PlatformId platform) {
        String path = "knowledge/" + platform.wire() + ".json";
        try (InputStream in = new ClassPathResource(path).getInputStream()) {
            return mapper.readValue(in, KnowledgeDoc.class);
        } catch (IOException e) {
            throw new IllegalStateException("Failed to load knowledge seed: " + path, e);
        }
    }
}

package ai.procurecopilot.backend.knowledge;

import ai.procurecopilot.backend.common.PlatformId;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

/**
 * In-memory guided-RAG knowledge registry (PROCURE_COPILOT_PLAN.md guided-RAG knowledge layer).
 * Seeds curated extraction policies + hints per platform from {@code classpath:knowledge/{platform}.json}
 * at construction, then lets the device append observations (the "RAG" learnings) which accumulate
 * in memory. Mirrors {@code PlaybookRegistry}: thread-safe via {@link ConcurrentHashMap} keyed by
 * platform, with each platform's appended notes guarded by a synchronized list.
 */
@Service
public class KnowledgeService {

    private final ObjectMapper mapper;
    private final Map<PlatformId, KnowledgeDoc> seeds = new ConcurrentHashMap<>();
    private final Map<PlatformId, List<KnowledgeNote>> notes = new ConcurrentHashMap<>();

    public KnowledgeService(ObjectMapper mapper) {
        this.mapper = mapper;
        for (PlatformId platform : PlatformId.values()) {
            seeds.put(platform, load(platform));
            notes.put(platform, new ArrayList<>());
        }
    }

    /** The current doc for a platform: seed policies/hints + all appended observations. */
    public KnowledgeDoc get(PlatformId platform) {
        KnowledgeDoc seed = seeds.get(platform);
        List<KnowledgeNote> appended = notes.get(platform);
        List<KnowledgeNote> snapshot;
        synchronized (appended) {
            snapshot = new ArrayList<>(appended);
        }
        return new KnowledgeDoc(
                seed.platform(), seed.version(), seed.policies(), seed.hints(), snapshot);
    }

    /** Append an observation to a platform's corpus and return the updated doc. Thread-safe. */
    public KnowledgeDoc addObservation(PlatformId platform, String kind, String text) {
        KnowledgeNote note = new KnowledgeNote(Instant.now().toString(), kind, text);
        List<KnowledgeNote> appended = notes.get(platform);
        synchronized (appended) {
            appended.add(note);
        }
        return get(platform);
    }

    /** Every platform's current doc. */
    public List<KnowledgeDoc> list() {
        List<KnowledgeDoc> all = new ArrayList<>();
        for (PlatformId platform : PlatformId.values()) {
            all.add(get(platform));
        }
        return all;
    }

    private KnowledgeDoc load(PlatformId platform) {
        String path = "knowledge/" + platform.wire() + ".json";
        try (InputStream in = new ClassPathResource(path).getInputStream()) {
            return mapper.readValue(in, KnowledgeDoc.class);
        } catch (IOException e) {
            throw new IllegalStateException("Failed to load knowledge seed: " + path, e);
        }
    }
}

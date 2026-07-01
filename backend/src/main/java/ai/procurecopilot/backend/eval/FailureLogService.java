package ai.procurecopilot.backend.eval;

import ai.procurecopilot.backend.common.PlatformId;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Persists the eval-observability failure corpus and decides when a recurring failure warrants a
 * self-improvement run. Each on-device report becomes a {@link FailureLogEntity} keyed by a stable
 * {@code signature} (the device's, falling back to SKU, then a slug of name+reason). A failure is
 * "repeating" once the same signature has been seen at least {@link #REPEAT_THRESHOLD} times within
 * {@link #REPEAT_WINDOW} — the cheap signal the trigger layer (B4) uses to fire a REPEATING_FAILURE
 * eval, itself rate-limited to at most one per hour.
 */
@Service
public class FailureLogService {

    /** A signature must recur at least this many times in the window to count as "repeating". */
    static final int REPEAT_THRESHOLD = 2;

    /** Rolling window over which repeats are counted. */
    static final Duration REPEAT_WINDOW = Duration.ofHours(24);

    private static final int RECENT_LIMIT = 200;

    private final FailureLogRepository repo;

    public FailureLogService(FailureLogRepository repo) {
        this.repo = repo;
    }

    /** Persist a device failure report, stamping the server receive time. */
    @Transactional
    public FailureLogEntity record(PlatformId platform, FailureIngest ingest, Instant now) {
        FailureLogEntity entity = new FailureLogEntity(
                platform.wire(),
                blankToDefault(ingest.flow(), "unknown"),
                signatureFor(ingest),
                ingest.reason(),
                ingest.url(),
                ingest.domDigest(),
                ingest.screenshotBase64(),
                ingest.skuId(),
                ingest.itemName(),
                now);
        return repo.save(entity);
    }

    /** True once this signature has recurred enough within the window to be worth re-evaluating. */
    @Transactional(readOnly = true)
    public boolean isRepeating(PlatformId platform, String signature, Instant now) {
        long count = repo.countByPlatformAndSignatureAndCreatedAtAfter(
                platform.wire(), signature, now.minus(REPEAT_WINDOW));
        return count >= REPEAT_THRESHOLD;
    }

    /** The unconsumed failures for a platform, oldest first — the input set for an eval run. */
    @Transactional(readOnly = true)
    public List<FailureLogEntity> unconsumed(PlatformId platform) {
        return repo.findByPlatformAndConsumedFalseOrderByCreatedAtAsc(platform.wire());
    }

    /** Mark a batch of failures as folded into an eval run so they are never re-processed. */
    @Transactional
    public void markConsumed(List<FailureLogEntity> entities) {
        for (FailureLogEntity e : entities) {
            e.markConsumed();
        }
        repo.saveAll(entities);
    }

    /** The most recent failures for a platform (any consumed state), newest first. */
    @Transactional(readOnly = true)
    public List<FailureLogEntity> recent(PlatformId platform, int limit) {
        int bounded = Math.max(1, Math.min(limit, RECENT_LIMIT));
        return repo.findByPlatformOrderByCreatedAtDesc(platform.wire(), PageRequest.of(0, bounded));
    }

    /** The stable dedup key: device signature, else SKU, else a slug of item name + reason. */
    String signatureFor(FailureIngest ingest) {
        if (notBlank(ingest.signature())) {
            return ingest.signature().trim();
        }
        if (notBlank(ingest.skuId())) {
            return ingest.skuId().trim();
        }
        String basis = (str(ingest.itemName()) + " " + str(ingest.reason())).trim();
        String slug = basis.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-")
                .replaceAll("(^-+|-+$)", "");
        return slug.isEmpty() ? "unknown" : slug;
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }

    private static String str(String s) {
        return s == null ? "" : s;
    }

    private static String blankToDefault(String s, String fallback) {
        return notBlank(s) ? s.trim() : fallback;
    }
}

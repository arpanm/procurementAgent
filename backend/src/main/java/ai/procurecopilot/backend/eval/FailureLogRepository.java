package ai.procurecopilot.backend.eval;

import java.time.Instant;
import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data repository for the eval-observability failure corpus. */
public interface FailureLogRepository extends JpaRepository<FailureLogEntity, Long> {

    /** Unconsumed failures for a platform, oldest first — the input set for an eval run. */
    List<FailureLogEntity> findByPlatformAndConsumedFalseOrderByCreatedAtAsc(String platform);

    /** Most recent failures for a platform (any consumed state), newest first. */
    List<FailureLogEntity> findByPlatformOrderByCreatedAtDesc(String platform, Pageable pageable);

    /** How many times this exact signature has failed on this platform since {@code since}. */
    long countByPlatformAndSignatureAndCreatedAtAfter(
            String platform, String signature, Instant since);
}

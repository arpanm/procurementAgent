package ai.procurecopilot.backend.eval;

import java.time.Instant;
import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data repository for the immutable eval-run audit history. */
public interface EvalRunRepository extends JpaRepository<EvalRunEntity, Long> {

    /** A platform's eval runs, newest first. */
    List<EvalRunEntity> findByPlatformOrderByStartedAtDesc(String platform, Pageable pageable);

    /** Whether a run with this trigger already started for this platform since {@code since}. */
    boolean existsByPlatformAndTriggerAndStartedAtAfter(
            String platform, EvalTrigger trigger, Instant since);
}

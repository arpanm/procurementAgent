package ai.procurecopilot.backend.eval;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data repository for gated knowledge patches awaiting human promotion/rejection. */
public interface PendingPatchRepository extends JpaRepository<PendingPatchEntity, Long> {

    /** Patches for a platform in a given lifecycle state, newest first. */
    List<PendingPatchEntity> findByPlatformAndStatusOrderByCreatedAtDesc(
            String platform, PatchStatus status);
}

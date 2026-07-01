package ai.procurecopilot.backend.eval;

import java.time.Instant;

/** A read view of a gated {@link PendingPatchEntity} awaiting human promotion/rejection. */
public record PendingPatchView(
        Long id,
        String platform,
        Long evalRunId,
        String kind,
        String description,
        String patchJson,
        PatchStatus status,
        Instant createdAt,
        Instant resolvedAt) {

    public static PendingPatchView of(PendingPatchEntity e) {
        return new PendingPatchView(
                e.getId(), e.getPlatform(), e.getEvalRunId(), e.getKind(), e.getDescription(),
                e.getPatchJson(), e.getStatus(), e.getCreatedAt(), e.getResolvedAt());
    }
}

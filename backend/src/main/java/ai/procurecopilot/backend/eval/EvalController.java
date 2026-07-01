package ai.procurecopilot.backend.eval;

import ai.procurecopilot.backend.common.PlatformId;
import ai.procurecopilot.backend.knowledge.KnowledgeDoc;
import java.util.List;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The eval-observability API (guided-RAG self-improvement loop). The device POSTs failures here; an
 * operator can trigger a run, inspect run history, and promote/reject the risky patches the pipeline
 * gated. The {@code platform} path variable is the lowercase wire string ("amazon" / "hyperpure").
 */
@RestController
public class EvalController {

    private static final int DEFAULT_LIMIT = 20;

    private final EvalTriggerService triggers;
    private final RagEvalService eval;
    private final EvalRunRepository runs;
    private final PendingPatchRepository pending;

    public EvalController(
            EvalTriggerService triggers,
            RagEvalService eval,
            EvalRunRepository runs,
            PendingPatchRepository pending) {
        this.triggers = triggers;
        this.eval = eval;
        this.runs = runs;
        this.pending = pending;
    }

    /** Ingest an on-device failure report; may fire a rate-limited repeating-failure eval. */
    @PostMapping("/eval/{platform}/failures")
    public EvalTriggerService.IngestResult reportFailure(
            @PathVariable String platform, @RequestBody FailureIngest body) {
        if (body == null || isBlank(body.signature()) && isBlank(body.skuId())
                && isBlank(body.itemName())) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST, "a signature, skuId or itemName is required");
        }
        return triggers.ingest(parse(platform), body);
    }

    /** Manually trigger an eval pass for a platform. */
    @PostMapping("/eval/{platform}/run")
    public EvalRunView runNow(@PathVariable String platform) {
        return EvalRunView.of(triggers.runManual(parse(platform)));
    }

    /** Recent eval-run history for a platform, newest first. */
    @GetMapping("/eval/{platform}/runs")
    public List<EvalRunView> recentRuns(
            @PathVariable String platform,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit) {
        int bounded = Math.max(1, Math.min(limit, 100));
        return runs.findByPlatformOrderByStartedAtDesc(parse(platform).wire(),
                        PageRequest.of(0, bounded))
                .stream().map(EvalRunView::of).toList();
    }

    /** The gated patches still awaiting a human verdict for a platform. */
    @GetMapping("/eval/{platform}/pending")
    public List<PendingPatchView> pendingPatches(@PathVariable String platform) {
        return pending.findByPlatformAndStatusOrderByCreatedAtDesc(
                        parse(platform).wire(), PatchStatus.PENDING)
                .stream().map(PendingPatchView::of).toList();
    }

    /** Promote a gated patch onto the live knowledge doc; returns the updated doc. */
    @PostMapping("/eval/{platform}/pending/{id}/promote")
    public KnowledgeDoc promote(@PathVariable String platform, @PathVariable long id) {
        PlatformId p = parse(platform);
        ensureBelongs(id, p);
        try {
            return eval.promote(id, java.time.Instant.now());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage());
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage());
        }
    }

    /** Reject a gated patch without touching the live doc. */
    @PostMapping("/eval/{platform}/pending/{id}/reject")
    public PendingPatchView reject(@PathVariable String platform, @PathVariable long id) {
        ensureBelongs(id, parse(platform));
        eval.reject(id, java.time.Instant.now());
        return PendingPatchView.of(pending.findById(id).orElseThrow());
    }

    private void ensureBelongs(long patchId, PlatformId platform) {
        PendingPatchEntity patch = pending.findById(patchId).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No pending patch " + patchId));
        if (!patch.getPlatform().equals(platform.wire())) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND, "Patch " + patchId + " is not on " + platform.wire());
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static PlatformId parse(String wire) {
        try {
            return PlatformId.fromWire(wire);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown platform: " + wire);
        }
    }
}

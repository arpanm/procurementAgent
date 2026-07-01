package ai.procurecopilot.backend.eval;

import ai.procurecopilot.backend.common.PlatformId;
import ai.procurecopilot.backend.knowledge.KnowledgeDoc;
import ai.procurecopilot.backend.knowledge.KnowledgeHints;
import ai.procurecopilot.backend.knowledge.KnowledgeNote;
import ai.procurecopilot.backend.knowledge.KnowledgePolicies;
import ai.procurecopilot.backend.knowledge.KnowledgeService;
import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The guided-RAG self-improvement engine. Gathers a platform's unconsumed failure logs, asks Claude
 * (vision + text: screenshots, DOM digests, reasons, and the current doc) for a structured {@link
 * KnowledgePatch}, then applies the hybrid-by-risk policy: token/search-note ADDITIONS are applied
 * straight onto the live doc (version bumped, an audit note appended), while REMOVALS and POLICY
 * FLIPS are parked as {@link PendingPatchEntity} for human promotion. Every pass writes an immutable
 * {@link EvalRunEntity}. The model never gates the device — it only widens or, with sign-off,
 * narrows what the device already does.
 */
@Service
public class RagEvalService {

    private static final Logger log = LoggerFactory.getLogger(RagEvalService.class);

    static final String TASK = "rag-eval";

    private static final int MAX_FAILURES_PER_RUN = 25;
    private static final int MAX_DIGEST_CHARS = 1200;

    private static final String SYSTEM = """
            You tune a web-automation agent's per-platform "knowledge" doc from its recent failures.
            You are given the current doc (policies + token hints) and a list of failed steps, each
            with a reason and (optionally) a page DOM digest / screenshot. Propose the SMALLEST change
            that would let the agent recognize what it missed. Reply with EXACTLY ONE JSON object, no
            prose:
            {"summary":string,
             "additions":{"rejectTokens":[],"processedVariantTokens":[],"atcTokens":[],
                          "addedTokens":[],"searchNotes":[]},
             "removals":{...same shape...},
             "policyFlips":{"priceFromDetailPage":true|false|null,
                            "trustListingPrice":true|false|null}}
            ADDITIONS are low risk (they only widen recognition) — prefer them: e.g. add the literal
            add-to-cart button label you see ("buy now") to atcTokens, or a confirmation phrase ("in
            your bag") to addedTokens. Use REMOVALS / policyFlips only when an existing hint is
            actively causing the failure; these are gated for human review. Leave a list empty / a
            flip null when you have nothing high-confidence. Never invent tokens not grounded in the
            evidence.""";

    private final ClaudeService claude;
    private final ObjectMapper mapper;
    private final KnowledgeService knowledge;
    private final FailureLogService failures;
    private final EvalRunRepository runs;
    private final PendingPatchRepository pending;

    public RagEvalService(
            ClaudeService claude,
            ObjectMapper mapper,
            KnowledgeService knowledge,
            FailureLogService failures,
            EvalRunRepository runs,
            PendingPatchRepository pending) {
        this.claude = claude;
        this.mapper = mapper;
        this.knowledge = knowledge;
        this.failures = failures;
        this.runs = runs;
        this.pending = pending;
    }

    /** Run one eval pass for a platform and return the persisted audit record. */
    @Transactional
    public EvalRunEntity evaluate(PlatformId platform, EvalTrigger trigger, Instant now) {
        EvalRunEntity run = new EvalRunEntity(platform.wire(), trigger, now);
        List<FailureLogEntity> batch = failures.unconsumed(platform);
        if (batch.size() > MAX_FAILURES_PER_RUN) {
            batch = batch.subList(0, MAX_FAILURES_PER_RUN);
        }
        run.setFailuresConsidered(batch.size());

        if (batch.isEmpty()) {
            run.setStatus(EvalStatus.NOOP);
            run.setSummary("No unconsumed failures to evaluate.");
            run.finish(now);
            return runs.save(run);
        }

        KnowledgeDoc doc = knowledge.get(platform);
        run.setVersions(doc.version(), doc.version());

        KnowledgePatch patch;
        try {
            String raw = claude.complete(buildRequest(platform, doc, batch));
            patch = parse(raw);
        } catch (RuntimeException e) {
            // Leave the batch UNCONSUMED so a later run can retry once the model/backend recovers.
            log.warn("rag-eval: model call/parse failed for {}: {}", platform.wire(), e.getMessage());
            run.setStatus(EvalStatus.ERROR);
            run.setError(e.getMessage());
            run.finish(now);
            return runs.save(run);
        }

        // These failures have now been weighed — never re-process them, regardless of outcome.
        failures.markConsumed(batch);

        Applied applied = applyAdditions(platform, doc, patch, now);
        List<PendingPatchEntity> gated = gateRisky(platform, run, patch, now);

        run.setVersions(doc.version(), applied.newVersion());
        run.setSummary(summarize(patch, applied, gated));
        run.setAppliedJson(toJson(patch.additions()));
        run.setPendingJson(toJson(Map.of(
                "removals", patch.removals(), "policyFlips", patch.policyFlips())));
        run.setStatus(applied.changed() || !gated.isEmpty() ? EvalStatus.SUCCESS : EvalStatus.NOOP);
        run.finish(now);
        EvalRunEntity saved = runs.save(run);
        // Backfill the run id on any gated patches now that the run is persisted.
        for (PendingPatchEntity p : gated) {
            p.setEvalRunId(saved.getId());
        }
        pending.saveAll(gated);
        return saved;
    }

    /** Promote a gated patch onto the live doc (applies its removals / policy flip). */
    @Transactional
    public KnowledgeDoc promote(long patchId, Instant now) {
        PendingPatchEntity patch = pending.findById(patchId).orElseThrow(
                () -> new IllegalArgumentException("No pending patch " + patchId));
        if (patch.getStatus() != PatchStatus.PENDING) {
            throw new IllegalStateException("Patch " + patchId + " is not pending");
        }
        PlatformId platform = PlatformId.fromWire(patch.getPlatform());
        KnowledgeDoc doc = knowledge.get(platform);
        KnowledgeDoc updated = "policy-flip".equals(patch.getKind())
                ? applyPolicyFlip(doc, readJson(patch.getPatchJson(), KnowledgePatch.PolicyFlips.class))
                : applyRemovals(doc, readJson(patch.getPatchJson(), KnowledgePatch.TokenSet.class));
        KnowledgeDoc bumped = bump(updated, "promoted patch: " + patch.getDescription(), now);
        knowledge.save(platform, bumped);
        patch.resolve(PatchStatus.PROMOTED, now);
        pending.save(patch);
        return bumped;
    }

    /** Reject a gated patch without touching the live doc. */
    @Transactional
    public void reject(long patchId, Instant now) {
        PendingPatchEntity patch = pending.findById(patchId).orElseThrow(
                () -> new IllegalArgumentException("No pending patch " + patchId));
        patch.resolve(PatchStatus.REJECTED, now);
        pending.save(patch);
    }

    // --- apply helpers -------------------------------------------------------

    private record Applied(boolean changed, int newVersion) {}

    private Applied applyAdditions(
            PlatformId platform, KnowledgeDoc doc, KnowledgePatch patch, Instant now) {
        KnowledgePatch.TokenSet add = patch.additions();
        if (add.isEmpty()) {
            return new Applied(false, doc.version());
        }
        KnowledgeHints h = doc.hints();
        Merge reject = mergeAppend(h.rejectTokens(), add.rejectTokens());
        Merge proc = mergeAppend(h.processedVariantTokens(), add.processedVariantTokens());
        Merge atc = mergeAppend(h.atcTokens(), add.atcTokens());
        Merge added = mergeAppend(h.addedTokens(), add.addedTokens());
        Merge notes = mergeAppend(h.searchNotes(), add.searchNotes());
        boolean changed = reject.changed || proc.changed || atc.changed || added.changed
                || notes.changed;
        if (!changed) {
            return new Applied(false, doc.version());
        }
        KnowledgeHints merged = new KnowledgeHints(
                reject.list, proc.list, atc.list, added.list, notes.list);
        KnowledgeDoc withHints = new KnowledgeDoc(
                doc.platform(), doc.version(), doc.policies(), merged, doc.notes());
        KnowledgeDoc bumped = bump(withHints,
                "eval: auto-applied additions — " + safeSummary(patch.summary()), now);
        knowledge.save(platform, bumped);
        return new Applied(true, bumped.version());
    }

    private List<PendingPatchEntity> gateRisky(
            PlatformId platform, EvalRunEntity run, KnowledgePatch patch, Instant now) {
        List<PendingPatchEntity> gated = new ArrayList<>();
        if (!patch.removals().isEmpty()) {
            gated.add(new PendingPatchEntity(
                    platform.wire(), null, "token-removal",
                    "Remove tokens flagged as causing failures. " + safeSummary(patch.summary()),
                    toJson(patch.removals()), now));
        }
        if (!patch.policyFlips().isEmpty()) {
            gated.add(new PendingPatchEntity(
                    platform.wire(), null, "policy-flip",
                    "Flip extraction policy. " + safeSummary(patch.summary()),
                    toJson(patch.policyFlips()), now));
        }
        return gated;
    }

    private KnowledgeDoc applyRemovals(KnowledgeDoc doc, KnowledgePatch.TokenSet rm) {
        KnowledgeHints h = doc.hints();
        KnowledgeHints stripped = new KnowledgeHints(
                without(h.rejectTokens(), rm.rejectTokens()),
                without(h.processedVariantTokens(), rm.processedVariantTokens()),
                without(h.atcTokens(), rm.atcTokens()),
                without(h.addedTokens(), rm.addedTokens()),
                without(h.searchNotes(), rm.searchNotes()));
        return new KnowledgeDoc(doc.platform(), doc.version(), doc.policies(), stripped, doc.notes());
    }

    private KnowledgeDoc applyPolicyFlip(KnowledgeDoc doc, KnowledgePatch.PolicyFlips flips) {
        KnowledgePolicies p = doc.policies();
        KnowledgePolicies next = new KnowledgePolicies(
                flips.priceFromDetailPage() != null
                        ? flips.priceFromDetailPage() : p.priceFromDetailPage(),
                flips.trustListingPrice() != null
                        ? flips.trustListingPrice() : p.trustListingPrice());
        return new KnowledgeDoc(doc.platform(), doc.version(), next, doc.hints(), doc.notes());
    }

    private KnowledgeDoc bump(KnowledgeDoc doc, String noteText, Instant now) {
        List<KnowledgeNote> notes = new ArrayList<>(doc.notes());
        notes.add(new KnowledgeNote(now.toString(), "eval", noteText));
        return new KnowledgeDoc(
                doc.platform(), doc.version() + 1, doc.policies(), doc.hints(), notes);
    }

    // --- prompt + parsing ----------------------------------------------------

    private ClaudeRequest buildRequest(
            PlatformId platform, KnowledgeDoc doc, List<FailureLogEntity> batch) {
        String image = batch.stream()
                .map(FailureLogEntity::getScreenshotBase64)
                .filter(s -> s != null && !s.isBlank())
                .findFirst()
                .orElse(null);
        String user = serializeUser(platform, doc, batch);
        return new ClaudeRequest(TASK, SYSTEM, user, 900, image, image == null ? null : "image/png");
    }

    private String serializeUser(
            PlatformId platform, KnowledgeDoc doc, List<FailureLogEntity> batch) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("platform", platform.wire());
        payload.put("currentDoc", doc);
        List<Map<String, Object>> fs = new ArrayList<>();
        for (FailureLogEntity f : batch) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("flow", f.getFlow());
            m.put("signature", f.getSignature());
            m.put("reason", f.getReason());
            m.put("url", f.getUrl());
            m.put("itemName", f.getItemName());
            m.put("domDigest", clip(f.getDomDigest()));
            fs.add(m);
        }
        payload.put("failures", fs);
        try {
            return mapper.writeValueAsString(payload);
        } catch (Exception e) {
            return "platform=" + platform.wire() + " failures=" + batch.size();
        }
    }

    /** Defensively parse the model completion into a patch, or an empty (no-op) patch. */
    KnowledgePatch parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return emptyPatch();
        }
        int start = raw.indexOf('{');
        int end = raw.lastIndexOf('}');
        if (start < 0 || end <= start) {
            return emptyPatch();
        }
        try {
            return mapper.readValue(raw.substring(start, end + 1), KnowledgePatch.class);
        } catch (Exception e) {
            log.debug("rag-eval: unparseable completion, treating as no-op: {}", e.getMessage());
            return emptyPatch();
        }
    }

    private static KnowledgePatch emptyPatch() {
        return new KnowledgePatch("", null, null, null);
    }

    // --- small utilities -----------------------------------------------------

    private record Merge(List<String> list, boolean changed) {}

    /** Append additions not already present (case-insensitive), preserving existing order. */
    private static Merge mergeAppend(List<String> base, List<String> additions) {
        List<String> out = new ArrayList<>(base);
        Set<String> seen = new LinkedHashSet<>();
        for (String b : base) {
            seen.add(b.toLowerCase(Locale.ROOT));
        }
        boolean changed = false;
        for (String a : additions) {
            if (a == null || a.isBlank()) {
                continue;
            }
            String t = a.trim();
            if (seen.add(t.toLowerCase(Locale.ROOT))) {
                out.add(t);
                changed = true;
            }
        }
        return new Merge(out, changed);
    }

    private static List<String> without(List<String> base, List<String> remove) {
        Set<String> drop = new LinkedHashSet<>();
        for (String r : remove) {
            drop.add(r.toLowerCase(Locale.ROOT));
        }
        List<String> out = new ArrayList<>();
        for (String b : base) {
            if (!drop.contains(b.toLowerCase(Locale.ROOT))) {
                out.add(b);
            }
        }
        return out;
    }

    private String summarize(KnowledgePatch patch, Applied applied, List<PendingPatchEntity> gated) {
        StringBuilder sb = new StringBuilder();
        sb.append(applied.changed() ? "Applied token/note additions. " : "No additions applied. ");
        if (!gated.isEmpty()) {
            sb.append("Gated ").append(gated.size()).append(" patch(es) for review. ");
        }
        sb.append(safeSummary(patch.summary()));
        return sb.toString().trim();
    }

    private static String safeSummary(String s) {
        return s == null ? "" : s.trim();
    }

    private static String clip(String s) {
        if (s == null) {
            return null;
        }
        return s.length() <= MAX_DIGEST_CHARS ? s : s.substring(0, MAX_DIGEST_CHARS) + "…";
    }

    private String toJson(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception e) {
            return "{}";
        }
    }

    private <T> T readJson(String json, Class<T> type) {
        try {
            return mapper.readValue(json, type);
        } catch (Exception e) {
            throw new IllegalStateException("Corrupt pending patch json", e);
        }
    }
}

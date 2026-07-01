package ai.procurecopilot.backend.eval;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.List;

/**
 * The structured change the LLM proposes for a platform's knowledge doc after weighing recent
 * failures. Split by risk so the pipeline can apply the hybrid policy: {@code additions} (new tokens
 * and search notes) are auto-applied because they only widen what the device recognizes and cannot
 * break a working flow; {@code removals} and {@code policyFlips} are gated for human promotion
 * because they can regress behavior. Null lists/fields normalize to empty so a partial completion is
 * still safe to apply.
 */
public record KnowledgePatch(
        String summary, TokenSet additions, TokenSet removals, PolicyFlips policyFlips) {

    public KnowledgePatch {
        additions = additions == null ? TokenSet.empty() : additions;
        removals = removals == null ? TokenSet.empty() : removals;
        policyFlips = policyFlips == null ? PolicyFlips.none() : policyFlips;
    }

    /** A set of token lists mirroring {@code KnowledgeHints}, used for both additions and removals. */
    public record TokenSet(
            List<String> rejectTokens,
            List<String> processedVariantTokens,
            List<String> atcTokens,
            List<String> addedTokens,
            List<String> searchNotes) {

        public TokenSet {
            rejectTokens = norm(rejectTokens);
            processedVariantTokens = norm(processedVariantTokens);
            atcTokens = norm(atcTokens);
            addedTokens = norm(addedTokens);
            searchNotes = norm(searchNotes);
        }

        public static TokenSet empty() {
            return new TokenSet(null, null, null, null, null);
        }

        @JsonIgnore
        public boolean isEmpty() {
            return rejectTokens.isEmpty()
                    && processedVariantTokens.isEmpty()
                    && atcTokens.isEmpty()
                    && addedTokens.isEmpty()
                    && searchNotes.isEmpty();
        }

        private static List<String> norm(List<String> in) {
            return in == null ? List.of() : List.copyOf(in);
        }
    }

    /** Proposed policy flips; a null field means "leave this policy unchanged". */
    public record PolicyFlips(Boolean priceFromDetailPage, Boolean trustListingPrice) {

        public static PolicyFlips none() {
            return new PolicyFlips(null, null);
        }

        @JsonIgnore
        public boolean isEmpty() {
            return priceFromDetailPage == null && trustListingPrice == null;
        }
    }
}

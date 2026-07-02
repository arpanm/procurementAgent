package ai.procurecopilot.backend.llm;

import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Rule-based secret scrubbing applied to every payload before it is sent to the Anthropic API or
 * written to logs (PROCURE_COPILOT_PLAN.md §2, §3.2, §9.5). Strips emails, phone numbers, OTP-like
 * and token/credential-like strings. This is a safety control: it must over-redact rather than ever
 * leak a credential.
 */
@Component
public class SecretScrubber {

    private static final Pattern EMAIL =
            Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");

    // Indian mobile numbers, optionally with +91 / 0 prefix and separators.
    private static final Pattern PHONE =
            Pattern.compile("(?<![\\d])(?:\\+?91[\\s-]?|0)?[6-9]\\d{4}[\\s-]?\\d{5}(?![\\d])");

    // Bearer/JWT/long opaque tokens and api-key-like strings.
    private static final Pattern TOKEN =
            Pattern.compile("(?i)(?:bearer\\s+)?[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{10,}(?:\\.[A-Za-z0-9_\\-]{10,})?");

    // Labeled credential: a secret-y keyword (whole word) followed by a separator and a value.
    // The keyword group is \b-bounded so it never matches inside ordinary words such as "task"
    // (which previously matched "sk") and corrupts structured JSON sent to the model. We omit bare
    // "key"/"token" to avoid mangling common English, and instead enumerate specific token kinds.
    private static final Pattern API_KEY =
            Pattern.compile(
                    "(?i)\\b(sk|pk|api[_-]?key|secret|password|passwd|pwd|access[_-]?token|"
                            + "refresh[_-]?token|auth[_-]?token|bearer|otp)\\b[\"'`:=\\s]+[A-Za-z0-9_\\-]{6,}");

    // OTP only when adjacent to an OTP/code label. We deliberately do NOT redact bare numbers, since
    // observations sent for grounding carry prices, element indices and bbox coordinates (4-8 digit
    // numbers) that must survive intact (PROCURE_COPILOT_PLAN.md §3.5.4).
    private static final Pattern OTP_FIELD =
            Pattern.compile("(?i)(one[\\s-]?time[\\s-]?code|otp|verification code|pin)\\D{0,12}\\d{3,8}");

    // Unlabeled 13-19 digit payment card / long account numbers (optionally grouped with single spaces
    // or dashes, e.g. "4111 1111 1111 1111"). Bounded so it can't fire on the 4-8 digit prices/bbox
    // coordinates in a DOM observation. This is the one residual an attacker-supplied page DOM could
    // otherwise leak into a grounding call.
    private static final Pattern CARD_NUMBER =
            Pattern.compile("(?<![\\d])(?:\\d[ -]?){12,18}\\d(?![\\d])");

    /** Returns a copy of {@code input} with secrets replaced by {@code [REDACTED]} markers. */
    public String scrub(String input) {
        if (input == null || input.isEmpty()) {
            return input;
        }
        String out = input;
        out = API_KEY.matcher(out).replaceAll("[REDACTED_CREDENTIAL]");
        out = OTP_FIELD.matcher(out).replaceAll("[REDACTED_OTP]");
        out = TOKEN.matcher(out).replaceAll("[REDACTED_TOKEN]");
        out = EMAIL.matcher(out).replaceAll("[REDACTED_EMAIL]");
        out = PHONE.matcher(out).replaceAll("[REDACTED_PHONE]");
        out = CARD_NUMBER.matcher(out).replaceAll("[REDACTED_CARD]");
        return out;
    }

    /** True if the input still appears to contain a secret after scrubbing (defensive check). */
    public boolean containsSecret(String input) {
        if (input == null) {
            return false;
        }
        return EMAIL.matcher(input).find()
                || PHONE.matcher(input).find()
                || API_KEY.matcher(input).find()
                || TOKEN.matcher(input).find()
                || CARD_NUMBER.matcher(input).find();
    }
}

/**
 * Device-side secret scrubber (PROCURE_COPILOT_PLAN.md §2, §3.2, §9.5).
 *
 * Every utterance is run through this BEFORE it leaves the device for the Spring Boot backend / the
 * Anthropic API or any log sink. Credentials, OTPs, phone numbers and emails must never reach an API
 * (DPDP Act, §2). The posture is deliberately conservative: when in doubt we over-redact rather than
 * risk leaking a secret. Order quantities (1-3 digit numbers like "5 kilo", "2 carton") are preserved
 * so intent/slot extraction still works.
 *
 * This is purely rule-based and framework-free so it is trivially unit-testable and runs with zero
 * network/LLM cost on every call.
 */

/** Placeholder substituted in for any redacted span. */
export const REDACTION_PLACEHOLDER = "[redacted]";

/** Email addresses. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Credential-style "keyword (is|:|=) value" pairs. The value token is redacted regardless of its
 * shape (could be alphanumeric, symbols, etc.), because anything a user labels as a secret is a
 * secret.
 */
const CREDENTIAL =
  /\b(?:otp|o\.t\.p|password|passcode|passwd|pwd|pin|cvv|cvc|secret|token|api[\s_-]?key|apikey|auth|login|username|user[\s_-]?id)\b\s*(?:is|are|:|=|->|=>)?\s*\S+/gi;

/**
 * Phone-number-like spans: an optional country prefix followed by digits, spaces, dashes, dots or
 * parens. We only redact a candidate when it actually contains enough digits to be a phone number,
 * so short quantities are never caught here.
 */
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{7,}\d/g;

/** Minimum digit count for a candidate span to be treated as a phone number. */
const MIN_PHONE_DIGITS = 10;

/**
 * Bare runs of 4+ digits: OTPs, account/card numbers, PINs typed without a label. Order quantities
 * are at most a few digits, so a 4+ digit run is far more likely to be a secret than a quantity.
 */
const LONG_DIGIT_RUN = /\d{4,}/g;

/** Collapses whitespace introduced by redaction without altering already-clean single-spaced text. */
const EXTRA_WHITESPACE = / {2,}/g;

function countDigits(value: string): number {
  let count = 0;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      count += 1;
    }
  }
  return count;
}

/**
 * Returns a copy of `text` with phone numbers, emails, OTP-like and obvious credential strings
 * replaced by {@link REDACTION_PLACEHOLDER}. Non-string / empty input yields an empty string.
 */
export function scrubForApi(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  let scrubbed = text.replace(EMAIL, REDACTION_PLACEHOLDER);

  scrubbed = scrubbed.replace(CREDENTIAL, REDACTION_PLACEHOLDER);

  scrubbed = scrubbed.replace(PHONE_CANDIDATE, (match) =>
    countDigits(match) >= MIN_PHONE_DIGITS ? REDACTION_PLACEHOLDER : match,
  );

  scrubbed = scrubbed.replace(LONG_DIGIT_RUN, REDACTION_PLACEHOLDER);

  return scrubbed.replace(EXTRA_WHITESPACE, " ").trim();
}

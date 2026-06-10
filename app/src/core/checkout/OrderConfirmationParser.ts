/**
 * Order-confirmation parser (PROCURE_COPILOT_PLAN.md Epic 6, §9.1 detectors). Extracts an order
 * reference + total from a {@link PlaceOrderResult} and/or a confirmation page ({@link Observation} or
 * a raw text/DOM snippet). Robust to missing fields: anything it cannot find comes back as `null`.
 *
 * The structured {@link PlaceOrderResult} (when the engine could read it) always wins; the text/DOM
 * extraction is the fallback for when the engine only managed to surface the rendered confirmation.
 */
import type { Observation, PlaceOrderResult } from "../automation/AutomationEngine";

export interface ParsedConfirmation {
  readonly orderRef: string | null;
  readonly totalPaise: number | null;
  readonly paidOnCredit: boolean;
}

export interface ConfirmationInput {
  readonly result?: PlaceOrderResult;
  readonly observation?: Observation;
  readonly text?: string;
}

/** Order reference: "Order ID: ABC-123", "Order no. 998877", "order reference #X9Y8". */
const ORDER_REF_RE =
  /order\s*(?:id|no\.?|number|reference|ref)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i;

/** Rupee total: "₹1,234.50", "Rs 980", "Total ₹2,000". */
const RUPEES_RE = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i;

const CREDIT_RE = /\b(?:paid\s+on\s+credit|on\s+credit|credit\s+line|pay\s+later)\b/i;

/** Flatten an observation into searchable text (title + each element's name/value). */
function observationText(observation: Observation): string {
  const parts: string[] = [observation.title];
  for (const el of observation.elements) {
    parts.push(el.name);
    if (el.value) {
      parts.push(el.value);
    }
  }
  return parts.join(" \n ");
}

/** Convert a rupee string like "1,234.50" to integer paise, rounding to the nearest paise. */
function rupeesToPaise(raw: string): number {
  const normalized = raw.replace(/,/g, "");
  const rupees = Number.parseFloat(normalized);
  if (!Number.isFinite(rupees)) {
    return Number.NaN;
  }
  return Math.round(rupees * 100);
}

export function parseOrderConfirmation(input: ConfirmationInput): ParsedConfirmation {
  const haystack = [
    input.text ?? "",
    input.observation ? observationText(input.observation) : "",
  ]
    .filter(Boolean)
    .join(" \n ");

  // --- order reference ---
  let orderRef: string | null = null;
  if (input.result && input.result.orderRef.trim() !== "") {
    orderRef = input.result.orderRef.trim();
  } else if (haystack) {
    const match = ORDER_REF_RE.exec(haystack);
    orderRef = match ? match[1] : null;
  }

  // --- total ---
  let totalPaise: number | null = null;
  if (input.result && Number.isFinite(input.result.totalPaise)) {
    totalPaise = input.result.totalPaise;
  } else if (haystack) {
    const match = RUPEES_RE.exec(haystack);
    if (match) {
      const paise = rupeesToPaise(match[1]);
      totalPaise = Number.isFinite(paise) ? paise : null;
    }
  }

  // --- paid on credit ---
  let paidOnCredit = false;
  if (input.result) {
    paidOnCredit = input.result.paidOnCredit;
  } else if (haystack) {
    paidOnCredit = CREDIT_RE.test(haystack);
  }

  return { orderRef, totalPaise, paidOnCredit };
}

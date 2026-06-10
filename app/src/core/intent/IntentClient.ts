/**
 * Conversation-layer intent client (PROCURE_COPILOT_PLAN.md §3.1, §3.2, Epic 1).
 *
 * Turns a raw chat/voice utterance into a structured list of {@link RequestedItem}s by calling the
 * backend `/intent` endpoint (which wraps Claude). Crucially it runs every utterance through
 * {@link scrubForApi} FIRST, so credentials/OTPs/phone numbers/emails are stripped on-device before
 * anything is sent to the backend or Anthropic (§9.5 "secret scrubbing before API calls").
 *
 * Low-confidence or empty extractions are handled gracefully: the caller always gets an array (never
 * a throw for "nothing recognised"), and can decide how to prompt the user to refine.
 */
import type { BackendClient } from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import { scrubForApi } from "./scrubForApi";

/** Below this confidence we still return the items but the UI may ask the user to confirm/refine. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export class IntentClient {
  constructor(private readonly backend: BackendClient) {}

  /**
   * Parses `text` into structured items. The text is scrubbed before leaving the device. Always
   * resolves to an array (possibly empty) so callers can render an editable list either way.
   */
  async parse(text: string, locale?: string): Promise<readonly RequestedItem[]> {
    const scrubbed = scrubForApi(text);
    if (scrubbed.length === 0) {
      return [];
    }

    const response = await this.backend.intent({ text: scrubbed, locale });
    return response.items ?? [];
  }

  /**
   * Like {@link parse} but also exposes the model's confidence so the UI can decide whether to show
   * a "did we get this right?" confirmation affordance.
   */
  async parseWithConfidence(
    text: string,
    locale?: string,
  ): Promise<{ items: readonly RequestedItem[]; confidence: number; lowConfidence: boolean }> {
    const scrubbed = scrubForApi(text);
    if (scrubbed.length === 0) {
      return { items: [], confidence: 0, lowConfidence: true };
    }

    const response = await this.backend.intent({ text: scrubbed, locale });
    const items = response.items ?? [];
    const confidence = response.confidence ?? 0;
    return {
      items,
      confidence,
      lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
    };
  }
}

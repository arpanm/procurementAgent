/**
 * Durable element SIGNATURES for the learned site-memory RAG (per-platform agents + RAG plan).
 *
 * A live {@link SerializedElement} carries an ephemeral `idx` (a per-perceive handle that changes every
 * render) plus durable, human-meaningful fields: tag, role, the visible `name` (aria-label / placeholder
 * / innerText), `attrs.type`/`attrs.href`, and a bounding box. A {@link ElementSignature} keeps only the
 * durable parts so a successful run can be REPLAYED next time: before falling back to heuristics or a
 * vision/Claude call, an agent tries to re-find "the element that looked like this" via
 * {@link matchSignature}. This is strictly best-effort — a stale signature simply scores too low and the
 * caller falls through — so a site redesign can never wedge a flow.
 *
 * Pure + framework-free (trivially unit-testable, zero cost).
 */
import type { Observation, SerializedElement } from "../automation/AutomationEngine";

/** The durable fingerprint of an element, learned from a successful interaction. */
export interface ElementSignature {
  readonly tag: string;
  readonly role: string | null;
  /** Normalised visible name (lowercased, whitespace-collapsed, truncated). */
  readonly namePattern: string;
  /** `attrs.type` (e.g. "search", "submit") when present. */
  readonly attrType?: string | null;
  /** Whether the element carried an href (links/product tiles). */
  readonly hasHref?: boolean;
  /** Approx center of the element when learned (device px) — a weak corroborating geometry signal. */
  readonly cx?: number;
  readonly cy?: number;
  /** 0..1 confidence, reinforced on repeat success and decayed on a miss. */
  readonly confidence: number;
  readonly lastSuccessAt: string;
  /** How many times this signature has been confirmed. */
  readonly hits: number;
}

const MAX_NAME = 80;

/** Lowercase + collapse whitespace + truncate, for a stable name comparison. */
export function normName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

function center(b: readonly [number, number, number, number]): { cx: number; cy: number } {
  return { cx: b[0] + b[2] / 2, cy: b[1] + b[3] / 2 };
}

/** Build a fresh signature (confidence 1, hits 1) from a live element. */
export function toSignature(
  el: SerializedElement,
  opts: { at?: string } = {},
): ElementSignature {
  const { cx, cy } = center(el.bbox);
  return {
    tag: el.tag,
    role: el.role,
    namePattern: normName(el.name),
    attrType: el.attrs?.type ?? null,
    hasHref: !!el.attrs?.href,
    cx,
    cy,
    confidence: 1,
    lastSuccessAt: opts.at ?? new Date().toISOString(),
    hits: 1,
  };
}

/** Do two signatures describe "the same" control (same tag + name)? Used to merge on re-learn. */
export function sameSignature(a: ElementSignature, b: ElementSignature): boolean {
  return a.tag === b.tag && a.namePattern === b.namePattern;
}

/**
 * Score how well a live element matches a stored signature. Tag is the strongest gate (a mismatch is a
 * hard zero — we must never click the wrong KIND of control); name/role/attrs add points, and a nearby
 * center adds a small corroborating bonus. Higher is better; 0 means "definitely not this".
 */
export function scoreSignature(el: SerializedElement, sig: ElementSignature): number {
  if (el.tag !== sig.tag) return 0;
  let score = 2; // tag matched
  if (sig.role && el.role === sig.role) score += 1;

  const name = normName(el.name);
  if (sig.namePattern) {
    if (name === sig.namePattern) score += 3;
    else if (name && (name.includes(sig.namePattern) || sig.namePattern.includes(name))) score += 2;
    else return 0; // a non-empty learned name that doesn't overlap → not this element
  }

  if (sig.attrType && el.attrs?.type === sig.attrType) score += 1;
  if (sig.hasHref !== undefined && !!el.attrs?.href === sig.hasHref) score += 1;

  if (sig.cx !== undefined && sig.cy !== undefined) {
    const { cx, cy } = center(el.bbox);
    if (Math.abs(cx - sig.cx) < 120 && Math.abs(cy - sig.cy) < 120) score += 1;
  }
  return score;
}

/** Minimum score for a confident signature match (tag + a meaningful name/attr corroboration). */
export const MATCH_THRESHOLD = 4;

/**
 * Find the live element best matching a stored signature, or null when nothing clears
 * {@link MATCH_THRESHOLD} (caller then falls back to heuristics/vision). When several stored
 * signatures are available, try each and return the highest-scoring element overall.
 */
export function matchSignature(
  obs: Observation,
  sigs: ElementSignature | readonly ElementSignature[],
): SerializedElement | null {
  const list = Array.isArray(sigs) ? sigs : [sigs as ElementSignature];
  let best: SerializedElement | null = null;
  let bestScore = MATCH_THRESHOLD - 1;
  for (const el of obs.elements) {
    for (const sig of list) {
      const score = scoreSignature(el, sig);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
  }
  return best;
}

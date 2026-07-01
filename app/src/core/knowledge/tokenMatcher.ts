/**
 * Build a case-insensitive matcher that EXTENDS a built-in base regex with extra knowledge-hint tokens.
 *
 * Guided-RAG knowledge "guides, never gates": curated/learned phrasings (e.g. a platform's specific
 * "ADD +" label or a newly-discovered "in your bag" confirmation) are escaped and OR'd onto the base
 * pattern, so they ADD recall without ever replacing the hard-coded matcher. Returns the base regex
 * unchanged when there are no usable tokens, so an absent/empty knowledge doc is a no-op.
 */
export function buildTokenMatcher(base: RegExp, tokens: readonly string[] | undefined): RegExp {
  const clean = (tokens ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return base;
  const escaped = clean.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`${base.source}|${escaped.join("|")}`, "i");
}

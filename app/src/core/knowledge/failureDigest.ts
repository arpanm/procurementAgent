/**
 * Compact, human-readable digest of a page {@link Observation} for a failure report.
 *
 * The full serialized DOM is large and may carry session text, so we never ship it. Instead we emit a
 * short, bounded summary — the URL plus the first N interactive/labelled elements — which is enough for
 * the backend eval (and a human) to see what the page looked like when a step failed, without the bulk.
 */
import type { Observation, SerializedElement } from "../automation/AutomationEngine";

const DEFAULT_MAX_ELEMENTS = 40;
const MAX_NAME_LEN = 48;

function describe(el: SerializedElement): string {
  const name = (el.name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
  const role = el.role ? `/${el.role}` : "";
  const type = el.attrs.type ? ` type=${el.attrs.type}` : "";
  return `[${el.idx}] ${el.tag}${role}${type} "${name}"`;
}

/** A bounded one-element-per-line digest: `url=… (N elements)` followed by up to `maxElements` rows. */
export function digestObservation(obs: Observation, maxElements = DEFAULT_MAX_ELEMENTS): string {
  const named = obs.elements.filter(
    (el) => (el.name ?? "").trim().length > 0 || el.tag === "button" || el.tag === "input" || el.tag === "a",
  );
  const head = `url=${obs.url} (${obs.elements.length} elements, ${named.length} labelled)`;
  const rows = named.slice(0, maxElements).map(describe);
  return [head, ...rows].join("\n");
}

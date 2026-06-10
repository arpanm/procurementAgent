/**
 * A tiny side-channel that lets the injected-script builders embed a machine-readable header in the
 * JS strings they produce. Production bridges (CapgoBridge) ignore it — the browser just executes the
 * IIFE. The in-process MockBridge (test/web-preview) reads it to know *which* pure perceiver/actor to
 * run against its jsdom document, so the engine can be exercised end-to-end without a device
 * (PROCURE_COPILOT_PLAN.md §3.5, §3.6.3).
 */
import type { EngineAction } from "../AutomationEngine";

export type ScriptMeta =
  | { readonly kind: "dom"; readonly requestId: string }
  | { readonly kind: "settle"; readonly requestId: string }
  | { readonly kind: "action"; readonly requestId: string; readonly action: EngineAction };

const OPEN = "/*__PC__";
const CLOSE = "__PC__*/";

/** Encode metadata as a leading JS comment. The payload never contains the CLOSE sentinel. */
export function encodeScriptMeta(meta: ScriptMeta): string {
  return `${OPEN}${JSON.stringify(meta)}${CLOSE}`;
}

/** Decode the metadata header from an injected script string, or null if absent/malformed. */
export function decodeScriptMeta(code: string): ScriptMeta | null {
  const start = code.indexOf(OPEN);
  if (start < 0) return null;
  const end = code.indexOf(CLOSE, start + OPEN.length);
  if (end < 0) return null;
  const json = code.slice(start + OPEN.length, end);
  try {
    return JSON.parse(json) as ScriptMeta;
  } catch {
    return null;
  }
}

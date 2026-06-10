/**
 * Hyperpure deterministic playbooks (PROCURE_COPILOT_PLAN.md §3.5.7, §3.5.11). Zero-LLM steps for
 * search → readProduct → addToCart → checkout, matched against the serialized DOM.
 */
import type { Playbooks } from "../../automation/WebViewAutomationEngine";
import { buildPlaybooks } from "./common";

export const HYPERPURE_PLAYBOOK_VERSION = "hyperpure@1";

export const hyperpurePlaybooks: Playbooks = buildPlaybooks({
  platform: "hyperpure",
  displayName: "Hyperpure",
});

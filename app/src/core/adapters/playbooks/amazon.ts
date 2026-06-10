/**
 * Amazon.in deterministic playbooks (PROCURE_COPILOT_PLAN.md §3.5.7, §3.5.11). Zero-LLM steps for
 * search → readProduct → addToCart → checkout, matched against the serialized DOM.
 */
import type { Playbooks } from "../../automation/WebViewAutomationEngine";
import { buildPlaybooks } from "./common";

export const AMAZON_PLAYBOOK_VERSION = "amazon@1";

export const amazonPlaybooks: Playbooks = buildPlaybooks({
  platform: "amazon",
  displayName: "Amazon.in",
});

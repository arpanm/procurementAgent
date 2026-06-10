/**
 * Public surface of the site adapters (PROCURE_COPILOT_PLAN.md Epic 3).
 *
 * The orchestrator imports `createEngine` to obtain a platform-bound automation engine, and the UI
 * imports `platformHealth` / `markStale` to render the per-platform health / "playbook stale" banner.
 * Selectors, playbooks and recorded fixtures are exported for reuse and testing.
 */
export {
  createEngine,
  platformHealth,
  allPlatformHealth,
  markStale,
  markHealthy,
  resetHealth,
  type PlatformHealth,
  type CreateEngineOptions,
} from "./SiteAdapterFactory";

export { hyperpurePlaybooks, HYPERPURE_PLAYBOOK_VERSION } from "./playbooks/hyperpure";
export { amazonPlaybooks, AMAZON_PLAYBOOK_VERSION } from "./playbooks/amazon";
export { buildPlaybooks, buildQuoteDraft, type PlatformLabels } from "./playbooks/common";

export * as selectors from "./selectors";
export * as fixtures from "./recordedFixtures";

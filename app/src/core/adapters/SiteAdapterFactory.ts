/**
 * Site adapter factory + per-platform health store (PROCURE_COPILOT_PLAN.md Epic 3).
 *
 * `createEngine` wires a `WebViewAutomationEngine` to the correct deterministic playbooks for a
 * platform, so the orchestrator never hard-codes which selectors a site uses. The factory also drives
 * the Epic 3 "per-platform health indicator" / "playbook stale self-heal banner": the engine's
 * `StepFailed` events (a playbook step that even the Claude fallback couldn't recover) mark the
 * platform stale, while successful reads/adds/orders mark it healthy again. The store is a simple
 * in-memory map the UI can subscribe to.
 */
import type { BackendClient } from "../backend/BackendClient";
import type { InAppBrowserBridge } from "../automation/bridge";
import type { PlatformId } from "../domain/types";
import {
  WebViewAutomationEngine,
  type Playbooks,
  type WebViewAutomationEngineOptions,
} from "../automation/WebViewAutomationEngine";
import { AMAZON_PLAYBOOK_VERSION, amazonPlaybooks } from "./playbooks/amazon";
import { HYPERPURE_PLAYBOOK_VERSION, hyperpurePlaybooks } from "./playbooks/hyperpure";

/** Health indicator surfaced to the UI for the per-platform banner. */
export interface PlatformHealth {
  readonly platform: PlatformId;
  readonly playbookVersion: string;
  readonly healthy: boolean;
  readonly lastError?: string;
}

/** Options accepted by `createEngine` beyond the platform/bridge/backend it always supplies. */
export type CreateEngineOptions = Omit<
  Partial<WebViewAutomationEngineOptions>,
  "platform" | "bridge" | "backend"
>;

interface PlatformConfig {
  readonly playbooks: Playbooks;
  readonly playbookVersion: string;
}

const PLATFORM_CONFIG: Readonly<Record<PlatformId, PlatformConfig>> = {
  hyperpure: { playbooks: hyperpurePlaybooks, playbookVersion: HYPERPURE_PLAYBOOK_VERSION },
  amazon: { playbooks: amazonPlaybooks, playbookVersion: AMAZON_PLAYBOOK_VERSION },
};

const healthStore = new Map<PlatformId, PlatformHealth>();

function defaultHealth(platform: PlatformId): PlatformHealth {
  return {
    platform,
    playbookVersion: PLATFORM_CONFIG[platform].playbookVersion,
    healthy: true,
  };
}

/** Current health for a platform (defaults to healthy until a failure is recorded). */
export function platformHealth(platform: PlatformId): PlatformHealth {
  return healthStore.get(platform) ?? defaultHealth(platform);
}

/** Snapshot of every known platform's health, for the dashboard/banner. */
export function allPlatformHealth(): readonly PlatformHealth[] {
  return (Object.keys(PLATFORM_CONFIG) as PlatformId[]).map(platformHealth);
}

/** Mark a platform's playbook stale (drives the "playbook stale" self-heal banner). */
export function markStale(platform: PlatformId, lastError?: string): PlatformHealth {
  const next: PlatformHealth = {
    platform,
    playbookVersion: PLATFORM_CONFIG[platform].playbookVersion,
    healthy: false,
    lastError,
  };
  healthStore.set(platform, next);
  return next;
}

/** Mark a platform healthy again (e.g. after a successful read/add/order). */
export function markHealthy(platform: PlatformId): PlatformHealth {
  const next = defaultHealth(platform);
  healthStore.set(platform, next);
  return next;
}

/** Reset the in-memory health store (test hygiene). */
export function resetHealth(): void {
  healthStore.clear();
}

/**
 * Construct a `WebViewAutomationEngine` for `platform` bound to the right playbooks, and wire its
 * domain events into the health store. Extra engine options (delay/sleep/thresholds/playbook
 * overrides) may be supplied and take precedence.
 */
export function createEngine(
  platform: PlatformId,
  bridge: InAppBrowserBridge,
  backend: BackendClient,
  opts: CreateEngineOptions = {},
): WebViewAutomationEngine {
  const playbooks = opts.playbooks ?? PLATFORM_CONFIG[platform].playbooks;
  const engine = new WebViewAutomationEngine({
    ...opts,
    platform,
    bridge,
    backend,
    playbooks,
  });

  if (!healthStore.has(platform)) healthStore.set(platform, defaultHealth(platform));

  engine.on((event) => {
    switch (event.type) {
      case "StepFailed":
        markStale(platform, event.reason);
        break;
      case "QuoteRead":
      case "ItemAddedToCart":
      case "OrderPlaced":
        markHealthy(platform);
        break;
      default:
        break;
    }
  });

  return engine;
}

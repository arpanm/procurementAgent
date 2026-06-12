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
import type { CartSnapshot, Observation } from "../automation/AutomationEngine";
import type { PlatformId } from "../domain/types";
import {
  WebViewAutomationEngine,
  type Playbooks,
  type WebViewAutomationEngineOptions,
} from "../automation/WebViewAutomationEngine";
import { AMAZON_PLAYBOOK_VERSION, amazonPlaybooks } from "./playbooks/amazon";
import { HYPERPURE_PLAYBOOK_VERSION, hyperpurePlaybooks } from "./playbooks/hyperpure";
import { readCartLines, asinFromUrl } from "./selectors";

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
  /** Cart-page URL `getCart` navigates to before reading the cart for verification. */
  readonly cartUrl: string;
  /** Optional server-side add-to-cart URL builder from the current product URL + quantity. */
  readonly cartAddUrl?: (currentUrl: string, qty: number) => string | null;
}

const PLATFORM_CONFIG: Readonly<Record<PlatformId, PlatformConfig>> = {
  hyperpure: {
    playbooks: hyperpurePlaybooks,
    playbookVersion: HYPERPURE_PLAYBOOK_VERSION,
    cartUrl: "https://www.hyperpure.com/in/cart",
  },
  amazon: {
    playbooks: amazonPlaybooks,
    playbookVersion: AMAZON_PLAYBOOK_VERSION,
    cartUrl: "https://www.amazon.in/gp/cart/view.html",
    // Amazon's mobile detail-page "Add to cart" handler is dead (its JS double-loads), so add via the
    // documented server-side cart-add endpoint instead — it adds the exact quantity in one round-trip
    // and honours the logged-in session. Needs the ASIN, which we lift from the current product URL.
    cartAddUrl: (currentUrl, qty) => {
      const asin = asinFromUrl(currentUrl);
      if (!asin) return null;
      const q = Math.max(1, Math.floor(qty));
      return `https://www.amazon.in/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=${q}`;
    },
  },
};

/** Heuristic cart reader shared by all platforms: parse product rows off the serialized cart page. */
function platformCartReader(obs: Observation, platform: PlatformId): CartSnapshot {
  const lines = readCartLines(obs.elements);
  const subtotalPaise = lines.reduce((sum, l) => sum + l.unitPricePaise * l.qty, 0);
  return { platform, lines, subtotalPaise };
}

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
    // A real cart reader + cart-page URL so the Verifier reads the actual cart (the engine default is an
    // empty cart, which would make verification fail no matter what add-to-cart did). Overridable.
    cartReader: platformCartReader,
    cartUrl: PLATFORM_CONFIG[platform].cartUrl,
    cartAddUrl: PLATFORM_CONFIG[platform].cartAddUrl,
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

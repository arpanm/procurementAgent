/**
 * Resolves the {@link PlatformAgent} for a platform, given its {@link BrowserSession}.
 *
 * Phase 1 returns a {@link LegacyAgent} for every platform (behavior-neutral delegation to the engine).
 * As real per-platform agents land (AmazonAgent, HyperpureAgent) this is the single place that swaps them
 * in, so the rest of the app depends only on the {@link PlatformAgent} contract.
 */
import type { PlatformId } from "../domain/types";
import type { AutomationEngine } from "../automation/AutomationEngine";
import type { KnowledgeDoc } from "../knowledge/PlatformKnowledge";
import type { SiteMemory } from "../knowledge/siteMemory";
import { PLATFORM_CART_URLS, PLATFORM_URLS } from "../config";
import { AmazonAgent } from "./amazon/AmazonAgent";
import { HyperpureAgent } from "./hyperpure/HyperpureAgent";
import { LegacyAgent } from "./LegacyAgent";
import type { BrowserSession, PlatformAgent } from "./PlatformAgent";

export interface AgentOptions {
  /** Keep the platform webview hidden while reading/adding (pricing). */
  readonly hidden?: boolean;
  /**
   * The guided-RAG knowledge doc for this platform: curated/learned policies + hints that steer the
   * agent's strategy (e.g. `policies.priceFromDetailPage`). Optional — agents use safe built-in
   * behavior when absent, so this only ever *guides*, never gates.
   */
  readonly knowledge?: KnowledgeDoc;
  /**
   * Learned, persistent site memory for this platform (detail-page URLs + element signatures). The
   * agent reuses it before heuristics/vision and writes back on success. Optional — absent → pure
   * heuristic behavior.
   */
  readonly memory?: SiteMemory;
}

export function agentFor(
  platform: PlatformId,
  session: BrowserSession,
  opts: AgentOptions = {},
): PlatformAgent {
  // Each platform gets its dedicated agent. Amazon: detail-page true price + native add-to-cart.
  // Hyperpure: the working listing+vision read. LegacyAgent remains the fallback for any future platform.
  switch (platform) {
    case "amazon":
      return new AmazonAgent({
        session,
        homeUrl: PLATFORM_URLS.amazon,
        cartUrl: PLATFORM_CART_URLS.amazon,
        hidden: opts.hidden,
        knowledge: opts.knowledge,
      });
    case "hyperpure":
      return new HyperpureAgent({
        session,
        homeUrl: PLATFORM_URLS.hyperpure,
        cartUrl: PLATFORM_CART_URLS.hyperpure,
        hidden: opts.hidden,
        knowledge: opts.knowledge,
        memory: opts.memory,
      });
    default:
      return new LegacyAgent({
        session,
        homeUrl: PLATFORM_URLS[platform],
        cartUrl: PLATFORM_CART_URLS[platform],
      });
  }
}

/**
 * A {@link BrowserSession} exposes the raw perceive→act→screenshot primitives the real per-platform agents
 * need; the demo {@link MockAutomationEngine} does not. This narrows at runtime so we can use the same
 * call site for both: production engines get their dedicated agent, the mock falls back to the
 * behavior-neutral {@link LegacyAgent} (which only drives the high-level engine surface).
 */
function isBrowserSession(engine: AutomationEngine): engine is BrowserSession {
  const e = engine as Partial<BrowserSession>;
  return typeof e.observe === "function" && typeof e.act === "function";
}

/**
 * Resolve the right {@link PlatformAgent} for whatever engine we have. Real WebView engines (which expose
 * the {@link BrowserSession} primitives) get the dedicated Amazon/Hyperpure agents; the demo mock engine
 * gets a {@link LegacyAgent} so the demo journey keeps working unchanged.
 */
export function agentForEngine(
  platform: PlatformId,
  engine: AutomationEngine,
  opts: AgentOptions = {},
): PlatformAgent {
  if (isBrowserSession(engine)) {
    return agentFor(platform, engine, opts);
  }
  return new LegacyAgent({
    session: engine,
    homeUrl: PLATFORM_URLS[platform],
    cartUrl: PLATFORM_CART_URLS[platform],
    hidden: opts.hidden,
  });
}

/**
 * Per-platform agent seam (PROCURE_COPILOT_PLAN.md — per-platform agents).
 *
 * Until now Amazon and Hyperpure shared ONE playbook/selector/extraction path, which is why Amazon's
 * hostile mobile DOM kept breaking (wrong listing price, dead add-to-cart). A `PlatformAgent` owns the
 * STRATEGY for a single platform — how to get ready, search, turn a result into a {@link Quote} (deciding
 * for itself whether the listing tuple is enough or it must open the product detail page), and how to add
 * to the cart (returning an explicit added/failed result so checkout can hand off a product link when an
 * automated add isn't possible).
 *
 * The agent drives a {@link BrowserSession} — the low-level, platform-agnostic browser primitive (today
 * the Capgo WebView engine). Phase 1 introduces this layer additively: {@link LegacyAgent} simply
 * delegates to the existing engine so behavior is unchanged; later phases give Amazon/Hyperpure real,
 * divergent strategies.
 */
import type { PlatformId, Quote, RequestedItem } from "../domain/types";
import type {
  ActionResult,
  AutomationEngine,
  EngineAction,
  Observation,
} from "../automation/AutomationEngine";

/**
 * The low-level browser driver an agent operates: everything on {@link AutomationEngine} (open/close/show,
 * the high-level search/read/cart/checkout helpers, event subscription) PLUS the raw perceive→act→
 * screenshot primitives a per-platform agent needs to run its OWN strategy — e.g. open a product detail
 * page and parse the true price, or click a specific add-to-cart button and confirm the result.
 *
 * The Capgo WebView engine implements this; the demo {@link MockAutomationEngine} implements only the
 * high-level {@link AutomationEngine} (it never drives real DOM), which is why the behavior-neutral
 * {@link LegacyAgent} depends on the narrower {@link AutomationEngine}, not this.
 */
export interface BrowserSession extends AutomationEngine {
  /** Serialize the current page into an {@link Observation}. */
  observe(): Promise<Observation>;
  /** Execute one action (click/type/select/scroll/navigate) with retry + settle. */
  act(action: EngineAction): Promise<ActionResult>;
  /** Capture a webview screenshot as a data URL, or null on failure. */
  captureScreenshot(): Promise<string | null>;
}

/** One approved line to add to a platform's cart. `productUrl` lets the agent skip search when known. */
export interface CartLineRequest {
  readonly skuId: string;
  readonly qty: number;
  /** The product detail URL captured at quote time, so the agent can navigate straight to it. */
  readonly productUrl?: string;
  /**
   * The original requested item, so an agent without a `productUrl` can re-search to re-locate the
   * product before adding (the legacy/Hyperpure path). Optional: Amazon requires the detail page.
   */
  readonly item?: RequestedItem;
}

/**
 * Outcome of an agent's add-to-cart attempt. `added` means the line is really in the cart (the agent
 * confirmed it); `failed` means automation couldn't add it — `productUrl` is then surfaced to the user so
 * they can open the product and add it manually (the cart hand-off model the user asked for).
 */
export interface AddToCartResult {
  readonly status: "added" | "failed";
  readonly skuId: string;
  readonly qty: number;
  /** The platform's cart URL, when adding succeeded (for the "Review & checkout" hand-off). */
  readonly cartUrl?: string;
  /** The product detail URL, always echoed so a `failed` result can hand the user a direct link. */
  readonly productUrl?: string;
  /** Human-readable reason when `failed`. */
  readonly reason?: string;
}

/**
 * The result of reading a platform for one item: the {@link chosen} default quote (best ₹/unit among
 * exact brand+size matches, else the cheapest nearby substitute) PLUS the full ranked {@link candidates}
 * list (best first) the UI offers as an in-app "choose a nearby SKU" picker when there's no exact match.
 * {@link candidates} always includes {@link chosen}; a platform that reads only one product returns a
 * single-element list.
 */
export interface QuoteRead {
  readonly chosen: Quote;
  readonly candidates: readonly Quote[];
}

/**
 * The strategy contract for driving ONE platform. Each method runs against the agent's
 * {@link BrowserSession}. Implementations own all platform-specific knowledge (selectors, listing-vs-detail
 * extraction, add-to-cart mechanism).
 */
export interface PlatformAgent {
  readonly platform: PlatformId;

  /** Bring the platform to a ready state: open the homepage and ensure the session is signed in. */
  ensureReady(): Promise<void>;

  /** Drive a search for one requested item. */
  search(item: RequestedItem): Promise<void>;

  /**
   * Read the best-matching product plus ranked alternatives into a {@link QuoteRead}. The agent decides
   * whether the listing tuple is sufficient or it must open the product detail page for a trustworthy
   * price/availability/variant, and which candidate is the default ({@link QuoteRead.chosen}).
   */
  readQuote(item: RequestedItem): Promise<QuoteRead>;

  /**
   * Best-effort add a line to the cart. Returns an explicit {@link AddToCartResult} rather than throwing,
   * so checkout can stage what it can and hand off the rest. Never places the order.
   */
  addToCart(line: CartLineRequest): Promise<AddToCartResult>;
}

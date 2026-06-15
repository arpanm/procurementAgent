/**
 * The drop-in {@link PlatformAgent} for the pre-split world: it simply delegates every strategy method to
 * the existing {@link BrowserSession} (the Capgo WebView engine), reproducing today's behavior exactly.
 *
 * This keeps Phase 1 behavior-neutral — the agent seam exists and is testable, but nothing changes for the
 * running app until later phases swap in real per-platform agents (AmazonAgent, HyperpureAgent).
 */
import type { RequestedItem } from "../domain/types";
import type { AutomationEngine } from "../automation/AutomationEngine";
import type {
  AddToCartResult,
  CartLineRequest,
  PlatformAgent,
  QuoteRead,
} from "./PlatformAgent";

export interface LegacyAgentDeps {
  /** The behavior-neutral agent only needs the high-level engine surface, not the raw primitives. */
  readonly session: AutomationEngine;
  /** Platform homepage opened by {@link ensureReady} (omit to make readiness a no-op). */
  readonly homeUrl?: string;
  /** Platform cart URL echoed on a successful add (for the checkout hand-off). */
  readonly cartUrl?: string;
  /** Keep the webview hidden while navigating to add (default false). */
  readonly hidden?: boolean;
}

export class LegacyAgent implements PlatformAgent {
  private readonly session: AutomationEngine;
  private readonly homeUrl?: string;
  private readonly cartUrl?: string;
  private readonly hidden: boolean;

  constructor(deps: LegacyAgentDeps) {
    this.session = deps.session;
    this.homeUrl = deps.homeUrl;
    this.cartUrl = deps.cartUrl;
    this.hidden = deps.hidden ?? false;
  }

  get platform() {
    return this.session.platform;
  }

  async ensureReady(): Promise<void> {
    if (this.homeUrl) {
      await this.session.open(this.homeUrl, { hidden: false });
    }
  }

  search(item: RequestedItem): Promise<void> {
    return this.session.search(item);
  }

  async readQuote(item: RequestedItem): Promise<QuoteRead> {
    const chosen = await this.session.readProduct(item);
    return { chosen, candidates: [chosen] };
  }

  /**
   * Legacy add: navigate to the product (open its detail URL when known, else re-search the item) and
   * drive the engine's add-to-cart, treating a non-throw as success (the engine's own Verifier was the
   * source of truth before). Returns an `added` result echoing the cart/product URLs, or `failed` with the
   * error reason if the engine throws.
   */
  async addToCart(line: CartLineRequest): Promise<AddToCartResult> {
    try {
      if (line.productUrl) {
        await this.session.open(line.productUrl, { hidden: this.hidden });
      } else if (line.item) {
        await this.session.search(line.item);
      }
      await this.session.addToCart(line.skuId, line.qty);
      return {
        status: "added",
        skuId: line.skuId,
        qty: line.qty,
        cartUrl: this.cartUrl,
        productUrl: line.productUrl,
      };
    } catch (err) {
      return {
        status: "failed",
        skuId: line.skuId,
        qty: line.qty,
        productUrl: line.productUrl,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

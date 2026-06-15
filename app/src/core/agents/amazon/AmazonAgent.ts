/**
 * Amazon per-platform agent.
 *
 * Amazon's mobile site is hostile to the generic listing scrape: the search grid scatters prices, so the
 * shared path once read ₹99 for a product that is really ₹237, and its in-page "Add to Cart" handler is
 * dead (double-loaded JS). This agent fixes both by owning an Amazon-specific strategy:
 *
 *  - readQuote: search → pick the best result card → OPEN the product DETAIL page → read the TRUE buybox
 *    price/availability/pack from there ({@link extractAmazonDetail}). Falls back to the legacy engine read
 *    when the detail page can't be reached/parsed, so a hard failure still never invents a price.
 *  - addToCart: navigate to the product detail page, click its native "Add to Cart" button and CONFIRM the
 *    add. On success it returns `added`; if it can't add, it returns `failed` with the product URL so the
 *    app can hand the user a direct link to add it themselves (the model the user asked for).
 */
import type { Quote, RequestedItem } from "../../domain/types";
import type {
  Observation,
  SerializedElement,
} from "../../automation/AutomationEngine";
import type {
  AddToCartResult,
  BrowserSession,
  CartLineRequest,
  PlatformAgent,
  QuoteRead,
} from "../PlatformAgent";
import { parsePackSize } from "../../pricing/packPricing";
import type { KnowledgeDoc } from "../../knowledge/PlatformKnowledge";
import {
  amazonProductUrl,
  asinFromUrl,
  findAmazonResultCard,
} from "./selectors";
import { extractAmazonDetail } from "./detailExtract";

export interface AmazonAgentDeps {
  readonly session: BrowserSession;
  /** Platform homepage opened by {@link ensureReady}. */
  readonly homeUrl?: string;
  /** Cart URL echoed on a successful add (for the "Review & checkout" hand-off). */
  readonly cartUrl?: string;
  /** Keep the webview hidden while reading/adding (default false: visible, matching debug runs). */
  readonly hidden?: boolean;
  /**
   * Guided-RAG knowledge: `policies.priceFromDetailPage` decides whether to open the product page for the
   * true price (default true for Amazon); `hints.atcTokens`/`hints.addedTokens` extend the add-to-cart and
   * confirmation matchers. Absent → safe built-in defaults.
   */
  readonly knowledge?: KnowledgeDoc;
  /** Injectable clock for deterministic `readAt` in tests. */
  readonly now?: () => string;
}

const ATC_RE = /add to (?:cart|basket|bag)/i;
// Post-add confirmation markers Amazon shows once an item lands in the cart.
const ADDED_RE =
  /added to (?:your )?(?:cart|basket)|cart subtotal|subtotal \(|proceed to (?:buy|checkout)|go to cart|item(?:s)? in (?:your )?cart/i;

export class AmazonAgent implements PlatformAgent {
  readonly platform = "amazon" as const;

  private readonly session: BrowserSession;
  private readonly homeUrl?: string;
  private readonly cartUrl?: string;
  private readonly hidden: boolean;
  private readonly priceFromDetailPage: boolean;
  private readonly atcMatcher: RegExp;
  private readonly addedMatcher: RegExp;
  private readonly now: () => string;

  constructor(deps: AmazonAgentDeps) {
    this.session = deps.session;
    this.homeUrl = deps.homeUrl;
    this.cartUrl = deps.cartUrl;
    this.hidden = deps.hidden ?? false;
    // Knowledge GUIDES, never gates: default to Amazon's known-good behavior when absent.
    this.priceFromDetailPage = deps.knowledge?.policies.priceFromDetailPage ?? true;
    this.atcMatcher = buildTokenMatcher(ATC_RE, deps.knowledge?.hints.atcTokens);
    this.addedMatcher = buildTokenMatcher(ADDED_RE, deps.knowledge?.hints.addedTokens);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async ensureReady(): Promise<void> {
    if (this.homeUrl) {
      await this.session.open(this.homeUrl, { hidden: this.hidden });
    }
  }

  search(item: RequestedItem): Promise<void> {
    // Search itself works through the shared engine loop; the Amazon-specific intelligence is in how we
    // READ (detail page) and ADD (native button), not in typing the query.
    return this.session.search(item);
  }

  /**
   * Read the best Amazon match. The key divergence from the legacy path: instead of trusting the noisy
   * search-listing price, we open the product detail page and read the buybox price there.
   */
  async readQuote(item: RequestedItem): Promise<QuoteRead> {
    // Knowledge can flip Amazon to trust the listing price (skip the detail page). Default: open detail.
    if (!this.priceFromDetailPage) {
      const chosen = await this.session.readProduct(item);
      return { chosen, candidates: [chosen] };
    }
    const listing = await this.session.observe();
    const card = findAmazonResultCard(listing, item);
    const productUrl = card ? amazonProductUrl(card, listing.url) : undefined;

    if (productUrl) {
      try {
        await this.session.open(productUrl, { hidden: this.hidden });
        const detailObs = await this.session.observe();
        const detail = extractAmazonDetail(detailObs);
        if (typeof detail.pricePaise === "number" && detail.pricePaise > 0) {
          const asin = asinFromUrl(productUrl);
          const title = detail.title ?? item.name;
          const chosen: Quote = {
            platform: "amazon",
            skuId: asin ?? slugify(title),
            canonicalItemId: canonicalIdOf(item),
            title,
            pricePaise: detail.pricePaise,
            mrpPaise: detail.mrpPaise,
            // Prefer the size we actually saw on the detail page; else the user's requested pack.
            packSize: detail.packSize ?? parsePackSize(title)?.raw ?? item.packSize,
            inStock: detail.inStock,
            productUrl,
            readAt: this.now(),
          };
          // Amazon reads ONE true buybox product (detail page), so it has no ranked alternatives.
          return { chosen, candidates: [chosen] };
        }
      } catch {
        /* fall through to the legacy read below — never invent a price */
      }
    }

    // Couldn't reach/parse the detail page: defer to the shared engine read (DOM + optional vision),
    // which is conservative and returns out-of-stock rather than a fabricated price.
    const chosen = await this.session.readProduct(item);
    return { chosen, candidates: [chosen] };
  }

  /**
   * Add a line to the Amazon cart from its detail page using the page's native "Add to Cart" button, then
   * confirm. Returns `added` only when the add is confirmed; otherwise `failed` with the product URL so the
   * user can open it and add manually.
   */
  async addToCart(line: CartLineRequest): Promise<AddToCartResult> {
    const productUrl = line.productUrl;
    if (!productUrl) {
      return {
        status: "failed",
        skuId: line.skuId,
        qty: line.qty,
        reason: "no product URL to open",
      };
    }

    try {
      await this.session.open(productUrl, { hidden: this.hidden });
      const obs = await this.session.observe();
      const button = findAddToCartButton(obs, this.atcMatcher);
      if (!button) {
        return {
          status: "failed",
          skuId: line.skuId,
          qty: line.qty,
          productUrl,
          reason: "no add-to-cart button on detail page",
        };
      }

      const result = await this.session.act({ type: "click", idx: button.idx });
      if (!result.ok) {
        return {
          status: "failed",
          skuId: line.skuId,
          qty: line.qty,
          productUrl,
          reason: result.reason ?? "add-to-cart click failed",
        };
      }

      const after = await this.session.observe();
      if (!addConfirmed(after, this.addedMatcher)) {
        return {
          status: "failed",
          skuId: line.skuId,
          qty: line.qty,
          productUrl,
          reason: "add-to-cart not confirmed on page",
        };
      }

      return {
        status: "added",
        skuId: line.skuId,
        qty: line.qty,
        cartUrl: this.cartUrl,
        productUrl,
      };
    } catch (err) {
      return {
        status: "failed",
        skuId: line.skuId,
        qty: line.qty,
        productUrl,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function elementText(el: SerializedElement): string {
  return `${el.name} ${el.value ?? ""} ${el.attrs.name ?? ""}`;
}

function isClickable(el: SerializedElement): boolean {
  return (
    el.tag === "button" ||
    el.role === "button" ||
    el.tag === "a" ||
    el.role === "link" ||
    el.tag === "input"
  );
}

/** The detail page's native "Add to Cart" control. */
function findAddToCartButton(obs: Observation, atc: RegExp): SerializedElement | undefined {
  return obs.elements.find((el) => isClickable(el) && atc.test(elementText(el)));
}

/** True when the page shows a post-add confirmation (item is really in the cart). */
function addConfirmed(obs: Observation, added: RegExp): boolean {
  return obs.elements.some((el) => added.test(elementText(el)));
}

/**
 * Combine a base regex with any extra knowledge hint tokens into one case-insensitive matcher. Tokens are
 * escaped and OR'd onto the base pattern, so curated/learned phrasings extend (never replace) the built-in
 * matcher. Returns the base regex unchanged when there are no usable tokens.
 */
function buildTokenMatcher(base: RegExp, tokens: readonly string[] | undefined): RegExp {
  const clean = (tokens ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return base;
  const escaped = clean.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`${base.source}|${escaped.join("|")}`, "i");
}

/** Stable SKU id from a title when no ASIN is available. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/**
 * The on-device {@link RequestedItem} carries a `canonicalItemId` at runtime (from `/intent` + `/plan`)
 * even though the TS type omits it; the optimizer maps quotes to demand by this id. Mirror the engine's
 * `canonicalIdOf` so agent-produced quotes match the same allocation key.
 */
function canonicalIdOf(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

/**
 * Hyperpure per-platform agent.
 *
 * Hyperpure's listing read already works through the shared engine's screenshot+vision path, so
 * {@link readQuote} keeps delegating to it. SEARCH and ADD-TO-CART are owned here and built around
 * Hyperpure's DETERMINISTIC URLs rather than the brittle type-into-box-and-press-Enter flow:
 *
 *  - SEARCH navigates STRAIGHT to the results URL (`/in/search/<slug>?query=...`). The old path typed the
 *    query into the search box and dispatched a synthetic Enter, but Hyperpure's autosuggest never acted on
 *    the synthetic keystroke — the box ended up holding the text while the page stayed on the PREVIOUS
 *    results (the "clicks search, never enters the term, never opens the URL, just comes out" + "2nd item
 *    never searched" bugs). Direct navigation removes the box, the Enter, and the autosuggest entirely.
 *
 *  - ADD-TO-CART opens the product DETAIL page (`/in/<slug>`, derived from the SKU slug or a captured
 *    productUrl) — a single-product page with one clean ADD button — then clicks ADD and CONFIRMS the add
 *    (ADD swaps to a "− qty +" stepper, or the header cart count rises). If the detail page doesn't hold the
 *    product it falls back to the search listing. Unconfirmed adds return `failed` with the product link so
 *    the user gets an honest manual hand-off instead of a phantom "added".
 *
 * Every step is traced via {@link traceAutomation} so the on-device debug log shows exactly what the agent
 * did (URLs opened, buttons clicked, confirm/fail) instead of only the low-level engine bridge chatter.
 */
import type { Observation, SerializedElement } from "../../automation/AutomationEngine";
import type { RequestedItem } from "../../domain/types";
import type { KnowledgeDoc } from "../../knowledge/PlatformKnowledge";
import type { SiteMemory } from "../../knowledge/siteMemory";
import { matchSignature, toSignature } from "../../knowledge/signature";
import { searchQueryFor } from "../../adapters/playbooks/common";
import { chooseQuote } from "../../pricing/matchKind";
import { traceAutomation } from "../../debug/automationDebug";
import type {
  AddToCartResult,
  BrowserSession,
  CartLineRequest,
  PlatformAgent,
  QuoteRead,
} from "../PlatformAgent";
import {
  addLooksConfirmed,
  findAddButtonForCard,
  findHyperpureAddButtons,
  findHyperpureProductCard,
  findPlusButtonNear,
  hyperpureProductUrl,
  hyperpureSearchUrl,
  isHyperpureProductUrl,
} from "./selectors";

const PLATFORM = "hyperpure" as const;

export interface HyperpureAgentDeps {
  readonly session: BrowserSession;
  /** Platform homepage opened by {@link ensureReady}. */
  readonly homeUrl?: string;
  /** Cart URL echoed on a successful add (for the "Review & checkout" hand-off). */
  readonly cartUrl?: string;
  /** Keep the webview hidden while reading/adding (default false: visible, matching debug runs). */
  readonly hidden?: boolean;
  /**
   * Guided-RAG knowledge for Hyperpure. `policies.trustListingPrice` (default true) keeps the
   * listing+vision read; a future doc could flip `priceFromDetailPage` to open the detail page instead.
   */
  readonly knowledge?: KnowledgeDoc;
  /**
   * Learned, persistent site memory: detail-page URLs per item + durable element signatures (search
   * box, product card, ADD button). The agent reuses these before falling back to heuristics/vision,
   * and writes back on a confirmed success. Optional — absent → pure heuristic behavior.
   */
  readonly memory?: SiteMemory;
}

/** Upper bound on stepper "+" clicks, so a misread tile can never loop adding forever. */
const MAX_QTY_CLICKS = 30;

export class HyperpureAgent implements PlatformAgent {
  readonly platform = "hyperpure" as const;

  private readonly session: BrowserSession;
  private readonly homeUrl?: string;
  private readonly cartUrl?: string;
  private readonly hidden: boolean;
  private readonly memory?: SiteMemory;

  constructor(deps: HyperpureAgentDeps) {
    this.session = deps.session;
    this.homeUrl = deps.homeUrl;
    this.cartUrl = deps.cartUrl;
    this.hidden = deps.hidden ?? false;
    this.memory = deps.memory;
  }

  async ensureReady(): Promise<void> {
    if (this.homeUrl) {
      await this.session.open(this.homeUrl, { hidden: this.hidden });
    }
  }

  /**
   * Search by navigating STRAIGHT to Hyperpure's results URL — no typing, no synthetic Enter, no
   * autosuggest race. Falls back to the engine's self-healing search only if the direct open throws.
   */
  async search(item: RequestedItem): Promise<void> {
    const query = searchQueryFor(item) || item.name;
    const url = hyperpureSearchUrl(query);
    traceAutomation("think", `▶ search "${query}" → opening results URL directly`, PLATFORM);
    traceAutomation("info", `search url → ${url}`, PLATFORM);
    try {
      await this.session.open(url, { hidden: this.hidden });
    } catch (err) {
      traceAutomation(
        "warn",
        `direct search-url open failed (${err instanceof Error ? err.message : String(err)}) → engine search`,
        PLATFORM,
      );
      await this.session.search(item);
    }
  }

  /**
   * Read from the LISTING via the engine's read (DOM + screenshot/vision fallback) — the path that
   * already sources Hyperpure correctly. Hyperpure's tiles carry a trustworthy price, so (unlike Amazon)
   * we do NOT open the detail page. When the engine exposes the ranked top-N candidate read we collect
   * all of them and let {@link chooseQuote} pick the default (best ₹/unit among exact brand+size
   * matches, else cheapest nearby); the alternatives feed the in-app picker. Engines without the
   * candidate read (mocks) degrade to a single product.
   */
  async readQuote(item: RequestedItem): Promise<QuoteRead> {
    if (this.session.readProductCandidates) {
      const candidates = await this.session.readProductCandidates(item);
      const chosen = chooseQuote(item, candidates) ?? candidates[0];
      traceAutomation(
        "info",
        `readQuote "${item.name}" → ${candidates.length} candidate(s); chose "${chosen.title}" (${chosen.matchKind ?? "?"})`,
        PLATFORM,
      );
      this.learnProductUrl(chosen.canonicalItemId, chosen.productUrl, chosen.title);
      return { chosen, candidates };
    }
    const chosen = await this.session.readProduct(item);
    this.learnProductUrl(chosen.canonicalItemId, chosen.productUrl, chosen.title);
    return { chosen, candidates: [chosen] };
  }

  /**
   * Open the product detail page (derived from the SKU slug or a captured URL), click its ADD button, and
   * CONFIRM the add really happened. Falls back to the search listing if the detail page doesn't hold the
   * product. Returns an explicit added/failed result (never throws to the caller).
   */
  async addToCart(line: CartLineRequest): Promise<AddToCartResult> {
    const detailUrl = this.detailUrlFor(line);
    traceAutomation("think", `▶ addToCart ${line.skuId} ×${line.qty}`, PLATFORM);
    try {
      let obs = await this.openProductPage(line, detailUrl);
      let card = this.locateCard(obs, line);

      // The detail URL is derived from a slug and can miss; recover via the search listing.
      if (!card && line.item) {
        traceAutomation("info", "product not on detail page → falling back to search listing", PLATFORM);
        await this.search(line.item);
        obs = await this.session.observe();
        card = this.locateCard(obs, line);
      }

      // Find the ADD control: card-nearest is most precise (a listing has many ADDs); else replay a
      // learned signature; else the first ADD on the page. Memory only ever speeds this up.
      const memoryButton =
        !card && this.memory
          ? matchSignature(obs, this.memory.recallLocators("detail:addToCart"))
          : null;
      const addButton =
        (card ? findAddButtonForCard(obs, card) : null) ??
        memoryButton ??
        (findHyperpureAddButtons(obs)[0] ?? null);
      if (!addButton) {
        traceAutomation("warn", `no ADD button on ${obs.url}`, PLATFORM);
        return this.fail(line, "no ADD button found on the product page", detailUrl);
      }
      if (memoryButton && memoryButton.idx === addButton.idx) {
        traceAutomation("info", `using learned ADD locator @${addButton.idx}`, PLATFORM);
      }

      traceAutomation("info", `clicking ADD @${addButton.idx} "${addButton.name ?? ""}"`, PLATFORM);
      await this.session.act({ type: "click", idx: addButton.idx });
      const after = await this.session.observe();
      if (!addLooksConfirmed(obs, after, addButton)) {
        traceAutomation("warn", `add not confirmed for ${line.skuId}`, PLATFORM);
        return this.fail(
          line,
          "add-to-cart not confirmed (cart count unchanged and no quantity stepper appeared)",
          detailUrl,
        );
      }

      traceAutomation("info", `✓ add confirmed; raising to qty ${line.qty}`, PLATFORM);
      await this.incrementTo(card ?? addButton, line.qty);

      // Learn from this confirmed success: the working ADD/card signatures and the detail URL we used.
      this.learnFromAdd(line, addButton, card, after, detailUrl);

      return {
        status: "added",
        skuId: line.skuId,
        qty: line.qty,
        cartUrl: this.cartUrl,
        productUrl: detailUrl,
      };
    } catch (err) {
      return this.fail(line, err instanceof Error ? err.message : String(err), detailUrl);
    }
  }

  // --- internals --------------------------------------------------------------------------------

  /**
   * The product DETAIL URL to open: a LEARNED url for this item (highest trust), else a captured
   * product URL, else one built from the SKU slug.
   */
  private detailUrlFor(line: CartLineRequest): string | undefined {
    const canonicalId = canonicalIdOf(line.item);
    const remembered = canonicalId ? this.memory?.recallProductUrl(canonicalId)?.url : undefined;
    if (remembered && isHyperpureProductUrl(remembered)) {
      traceAutomation("info", `using learned product URL → ${remembered}`, PLATFORM);
      return remembered;
    }
    if (line.productUrl && isHyperpureProductUrl(line.productUrl)) return line.productUrl;
    if (line.skuId) return hyperpureProductUrl(line.skuId);
    return line.productUrl;
  }

  /** Remember the detail-page URL we reached for an item (best-effort; only valid product URLs). */
  private learnProductUrl(
    canonicalItemId: string | undefined,
    url: string | undefined,
    title: string,
  ): void {
    if (!this.memory || !canonicalItemId || !url || !isHyperpureProductUrl(url)) return;
    this.memory.rememberProductUrl(canonicalItemId, url, title);
  }

  /** Write back the durable signatures + detail URL that produced a CONFIRMED add. */
  private learnFromAdd(
    line: CartLineRequest,
    addButton: SerializedElement,
    card: SerializedElement | null,
    after: Observation,
    detailUrl: string | undefined,
  ): void {
    if (!this.memory) return;
    this.memory.rememberLocator("detail:addToCart", toSignature(addButton));
    if (card) this.memory.rememberLocator("listing:productCard", toSignature(card));
    const url = isHyperpureProductUrl(after.url) ? after.url : detailUrl;
    this.learnProductUrl(canonicalIdOf(line.item), url, line.item?.name ?? line.skuId);
  }

  /** Open the detail page if we have one, else re-search; return the resulting observation. */
  private async openProductPage(
    line: CartLineRequest,
    detailUrl: string | undefined,
  ): Promise<Observation> {
    if (detailUrl) {
      traceAutomation("info", `opening product detail → ${detailUrl}`, PLATFORM);
      await this.session.open(detailUrl, { hidden: this.hidden });
    } else if (line.item) {
      await this.search(line.item);
    }
    return this.session.observe();
  }

  /** Match the product tile if we have the original item; on a single-product page the item context is enough. */
  private locateCard(obs: Observation, line: CartLineRequest): SerializedElement | null {
    return line.item ? findHyperpureProductCard(obs, line.item) : null;
  }

  /**
   * Best-effort raise the tile to the requested quantity using its "+" stepper. The first add already put
   * 1 in the cart, so we click "+" (qty − 1) more times; if the stepper can't be found we stop (1 is in
   * the cart) rather than fail the whole line.
   */
  private async incrementTo(anchor: SerializedElement, qty: number): Promise<void> {
    const clicks = Math.min(Math.max(qty - 1, 0), MAX_QTY_CLICKS);
    for (let i = 0; i < clicks; i++) {
      const obs = await this.session.observe();
      const plus = findPlusButtonNear(obs, anchor);
      if (!plus) {
        traceAutomation("warn", `qty stepper "+" not found at click ${i + 1}/${clicks}; stopping`, PLATFORM);
        return;
      }
      await this.session.act({ type: "click", idx: plus.idx });
    }
  }

  private fail(line: CartLineRequest, reason: string, productUrl?: string): AddToCartResult {
    traceAutomation("error", `✗ addToCart ${line.skuId}: ${reason}`, PLATFORM);
    return {
      status: "failed",
      skuId: line.skuId,
      qty: line.qty,
      productUrl: productUrl ?? line.productUrl,
      reason,
    };
  }
}

/**
 * The on-device {@link RequestedItem} carries a `canonicalItemId` at runtime (from `/intent` + `/plan`)
 * even though the TS type omits it; site memory keys product URLs by it. Falls back to the item name,
 * and to "" when the item is absent (so callers can skip the write).
 */
function canonicalIdOf(item?: RequestedItem): string {
  if (!item) return "";
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

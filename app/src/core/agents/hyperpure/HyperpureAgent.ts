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
  hyperpureSearchUrl,
  isHyperpureProductUrl,
  type HyperpureMatchOpts,
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

/** How many times to (re-locate + re-)click ADD before declaring an unconfirmed add a failure. */
const MAX_ADD_ATTEMPTS = 3;

export class HyperpureAgent implements PlatformAgent {
  readonly platform = "hyperpure" as const;

  private readonly session: BrowserSession;
  private readonly homeUrl?: string;
  private readonly cartUrl?: string;
  private readonly hidden: boolean;
  private readonly memory?: SiteMemory;
  /** Knowledge-derived ADD/added/reject tokens threaded into every selector call (guides, never gates). */
  private readonly matchOpts: HyperpureMatchOpts;

  constructor(deps: HyperpureAgentDeps) {
    this.session = deps.session;
    this.homeUrl = deps.homeUrl;
    this.cartUrl = deps.cartUrl;
    this.hidden = deps.hidden ?? false;
    this.memory = deps.memory;
    this.matchOpts = {
      atcTokens: deps.knowledge?.hints.atcTokens,
      addedTokens: deps.knowledge?.hints.addedTokens,
      rejectTokens: deps.knowledge?.hints.rejectTokens,
    };
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
      // Prefer a REAL product page (learned/captured URL); otherwise add straight from the search
      // listing, which Hyperpure renders more reliably than a guessed detail slug.
      let obs: Observation;
      let card: SerializedElement | null;
      if (detailUrl) {
        obs = await this.openProductPage(line, detailUrl);
        card = this.locateCard(obs, line);
      } else {
        obs = await this.session.observe();
        card = null;
      }

      // No card on the detail page (it missed) or no detail page at all → find the product on the search
      // listing, scrolling the virtualized grid until the matching tile renders.
      if (!card && line.item) {
        traceAutomation(
          "info",
          detailUrl ? "product not on detail page → searching listing" : "finding product on search listing",
          PLATFORM,
        );
        await this.search(line.item);
        obs = await this.settleListingForAdd(line);
        card = this.locateCard(obs, line);

        // With no known detail URL, open the chosen product's OWN detail page by tapping its tile —
        // Hyperpure tiles navigate via JS (no <a href>), so this is the only way to reach the canonical
        // single-ADD page. Adding there is unambiguous (one ADD for the exact SKU, vs. many tiles on the
        // listing) and yields the real detail URL to hand back / learn. Falls back to listing-add if the
        // tap doesn't land on a product page.
        if (card && !detailUrl) {
          const detailObs = await this.openDetailViaTile(card);
          if (detailObs) {
            obs = detailObs;
            card = this.locateCard(obs, line);
          }
        }
      }

      // Hand the user a link that actually resolves: the page we ended on if it's a real product page,
      // else the (reliable) search-results URL — never a guessed slug that bounces to home/cart.
      const handoffUrl = this.handoffUrlFor(line, obs, detailUrl);

      const outcome = await this.clickAddWithRetry(line, obs, card);
      if (!outcome.confirmed) {
        if (!outcome.addButton) {
          traceAutomation("warn", `no ADD button on ${outcome.after.url}`, PLATFORM);
          return this.fail(line, "no ADD button found on the product page", handoffUrl);
        }
        traceAutomation("warn", `add not confirmed for ${line.skuId}`, PLATFORM);
        this.traceAddDiag(outcome.after, outcome.addButton);
        return this.fail(
          line,
          "add-to-cart not confirmed (cart count unchanged and no quantity stepper appeared)",
          handoffUrl,
        );
      }

      traceAutomation("info", `✓ add confirmed; raising to qty ${line.qty}`, PLATFORM);
      await this.incrementTo(outcome.card ?? outcome.addButton, line.qty);

      // Learn from this confirmed success: the working ADD/card signatures and the URL we ended on.
      this.learnFromAdd(line, outcome.addButton, outcome.card, outcome.after, handoffUrl);

      return {
        status: "added",
        skuId: line.skuId,
        qty: line.qty,
        cartUrl: this.cartUrl,
        productUrl: handoffUrl,
      };
    } catch (err) {
      return this.fail(line, err instanceof Error ? err.message : String(err), detailUrl);
    }
  }

  /**
   * Click ADD and confirm it took — retrying with a FRESHLY re-located button when it doesn't. Hyperpure
   * re-renders on load (React hydration mismatch) which can wipe the `data-pc-idx` handle the observe
   * captured, so a click against a stale idx silently no-ops. Re-observing and re-matching the ADD on the
   * fresh DOM before the next click is what turns those invisible no-ops into a real add (or an honest
   * failure). Returns the button/card actually used plus the last observation for diagnostics.
   */
  private async clickAddWithRetry(
    line: CartLineRequest,
    initialObs: Observation,
    initialCard: SerializedElement | null,
  ): Promise<
    | { confirmed: true; after: Observation; addButton: SerializedElement; card: SerializedElement | null }
    | { confirmed: false; after: Observation; addButton: SerializedElement | null; card: SerializedElement | null }
  > {
    let obs = initialObs;
    let card = initialCard;
    let lastAdd: SerializedElement | null = null;
    for (let attempt = 1; attempt <= MAX_ADD_ATTEMPTS; attempt++) {
      const addButton = this.resolveAddButton(obs, card);
      if (!addButton) {
        // No ADD control anywhere on this page — re-observing can't conjure one.
        return { confirmed: false, after: obs, addButton: lastAdd, card };
      }
      lastAdd = addButton;
      traceAutomation(
        "info",
        attempt === 1
          ? `clicking ADD @${addButton.idx} "${addButton.name ?? ""}"`
          : `retry ${attempt}/${MAX_ADD_ATTEMPTS}: re-clicking ADD @${addButton.idx} (fresh locator)`,
        PLATFORM,
      );
      const res = await this.session.act({ type: "click", idx: addButton.idx });
      if (!res.ok) {
        traceAutomation("warn", `ADD click @${addButton.idx} reported not-ok${res.reason ? ` (${res.reason})` : ""}`, PLATFORM);
      }
      const after = await this.session.observe();
      if (addLooksConfirmed(obs, after, addButton, this.matchOpts)) {
        return { confirmed: true, after, addButton, card };
      }
      // Not confirmed — the handle may be stale; re-locate the card/ADD on the fresh DOM and try again.
      obs = after;
      card = this.locateCard(after, line) ?? card;
    }
    return { confirmed: false, after: obs, addButton: lastAdd, card };
  }

  /**
   * The ADD control to click: card-nearest is most precise (a listing has many ADDs); else replay a
   * learned signature; else the first ADD on the page. Memory only ever speeds this up.
   */
  private resolveAddButton(obs: Observation, card: SerializedElement | null): SerializedElement | null {
    const byCard = card ? findAddButtonForCard(obs, card, this.matchOpts) : null;
    if (byCard) return byCard;
    const memoryButton = this.memory
      ? matchSignature(obs, this.memory.recallLocators("detail:addToCart"))
      : null;
    if (memoryButton) {
      traceAutomation("info", `using learned ADD locator @${memoryButton.idx}`, PLATFORM);
      return memoryButton;
    }
    return findHyperpureAddButtons(obs, this.matchOpts)[0] ?? null;
  }

  // --- internals --------------------------------------------------------------------------------

  /**
   * The product DETAIL URL to open, ONLY when it's a REAL, proven page: a LEARNED url for this item
   * (highest trust — it produced a confirmed add before) or a captured product URL from quote time.
   *
   * We deliberately no longer build a URL from the SKU slug: a guessed slug frequently 404s or bounces
   * to a stray "explore more" page whose ADD button silently no-ops, which was the source of the
   * inconsistent "onion opens a listing, paneer opens a detail page, neither adds" behavior. With no
   * real URL, {@link addToCart} adds from the search listing, which Hyperpure renders far more reliably.
   */
  private detailUrlFor(line: CartLineRequest): string | undefined {
    const canonicalId = canonicalIdOf(line.item);
    const remembered = canonicalId ? this.memory?.recallProductUrl(canonicalId)?.url : undefined;
    if (remembered && isHyperpureProductUrl(remembered)) {
      traceAutomation("info", `using learned product URL → ${remembered}`, PLATFORM);
      return remembered;
    }
    if (line.productUrl && isHyperpureProductUrl(line.productUrl)) return line.productUrl;
    return undefined;
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

  /**
   * Open the chosen product's detail page by tapping its listing tile. Hyperpure search tiles are NOT
   * `<a href>` links (they route via JS and the slug lives only in React state), so tapping the tile is
   * the only reliable way to reach the product's own page from a listing. Polls a few times for the SPA
   * route to settle onto a real product URL with an ADD control. Returns the detail observation, or null
   * when the tap didn't navigate to a product page (caller then adds from the listing instead).
   */
  private async openDetailViaTile(card: SerializedElement): Promise<Observation | null> {
    traceAutomation("info", `opening product detail via tile @${card.idx}`, PLATFORM);
    await this.session.act({ type: "click", idx: card.idx });
    let obs = await this.session.observe();
    for (
      let i = 0;
      i < 6 && !(isHyperpureProductUrl(obs.url) && findHyperpureAddButtons(obs, this.matchOpts).length > 0);
      i++
    ) {
      obs = await this.session.observe();
    }
    if (isHyperpureProductUrl(obs.url)) {
      traceAutomation("info", `landed on product detail → ${obs.url}`, PLATFORM);
      return obs;
    }
    traceAutomation("info", "tile tap did not open a product page → adding from listing", PLATFORM);
    return null;
  }

  /** Match the product tile if we have the original item; on a single-product page the item context is enough. */
  private locateCard(obs: Observation, line: CartLineRequest): SerializedElement | null {
    return line.item ? findHyperpureProductCard(obs, line.item, this.matchOpts) : null;
  }

  /**
   * Hyperpure's results grid is virtualized — tiles (and their inline ADD buttons) only mount as they
   * scroll into view, so a single observe right after navigation sees just the page shell. Scroll a few
   * steps, re-observing until the matching card OR any ADD control appears (bounded), then return the
   * richest observation seen.
   */
  private async settleListingForAdd(line: CartLineRequest): Promise<Observation> {
    let obs = await this.session.observe();
    for (let i = 0; i < 8; i++) {
      if (this.locateCard(obs, line) || findHyperpureAddButtons(obs, this.matchOpts).length > 0) return obs;
      await this.session.act({ type: "scroll", dy: 600 });
      obs = await this.session.observe();
    }
    return obs;
  }

  /**
   * The link to hand back to the user (on success for "Review & checkout", on failure for a manual add):
   * the page we actually ended on when it's a real product page, else the reliable search-results URL for
   * the item, else the slug-derived detail URL as a last resort. Never returns a URL we know bounces away.
   */
  private handoffUrlFor(
    line: CartLineRequest,
    obs: Observation,
    detailUrl: string | undefined,
  ): string | undefined {
    if (isHyperpureProductUrl(obs.url)) return obs.url;
    if (line.item) return hyperpureSearchUrl(searchQueryFor(line.item) || line.item.name);
    return detailUrl;
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

  /**
   * Debug-only: when an add isn't confirmed, dump the post-click DOM AROUND the ADD button so we can see
   * what Hyperpure actually rendered (stepper glyphs, quantity badge, cart count) instead of guessing. This
   * is the add-to-cart analogue of the price-extraction digit-node diagnostic that pinpointed the serializer
   * gap. Cheap and bounded; only fires on the failure path.
   */
  private traceAddDiag(after: Observation, addButton: SerializedElement): void {
    const ax = addButton.bbox[0] + addButton.bbox[2] / 2;
    const ay = addButton.bbox[1] + addButton.bbox[3] / 2;
    const near = after.elements
      .filter((el) => {
        const cx = el.bbox[0] + el.bbox[2] / 2;
        const cy = el.bbox[1] + el.bbox[3] / 2;
        return Math.abs(cx - ax) < 260 && Math.abs(cy - ay) < 200;
      })
      .filter((el) => (el.name ?? "").trim().length > 0 || el.tag === "button");
    traceAutomation(
      "info",
      `add-diag near ADD@${addButton.idx} (${Math.round(ax)},${Math.round(ay)}): ${near.length} element(s)`,
      PLATFORM,
    );
    for (const el of near.slice(0, 16)) {
      const nm = (el.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      traceAutomation(
        "info",
        `  near [${el.idx}] ${el.tag}${el.role ? `/${el.role}` : ""} "${nm}"`,
        PLATFORM,
      );
    }
    const cartEls = after.elements.filter((el) =>
      /cart|basket/i.test(`${el.name ?? ""} ${el.attrs.href ?? ""}`),
    );
    for (const el of cartEls.slice(0, 4)) {
      const nm = (el.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      traceAutomation("info", `  cart [${el.idx}] ${el.tag} "${nm}" href=${el.attrs.href ?? ""}`, PLATFORM);
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

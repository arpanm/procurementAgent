/**
 * The WebView automation engine (PROCURE_COPILOT_PLAN.md §3.4, §3.5, §3.6).
 *
 * Implements `AutomationEngine` over an `InAppBrowserBridge` using the deterministic
 * perceive → reason → act loop: each step re-serializes the DOM, runs the platform `Playbook`
 * (zero-LLM) and falls back to `backend.nextAction` (Claude-grounded) when a step yields nothing or
 * fails to verify (§3.5.7). It adds human-like pacing, retry-with-backoff, a circuit breaker that
 * trips after N consecutive failed actions, `verifyStepEffect`, and OTP/payment hand-off detection.
 */
import type {
  PlatformId,
  Quote,
  RequestedItem,
} from "../domain/types";
import type { BackendClient } from "../backend/BackendClient";
import type {
  ActionResult,
  AutomationEngine,
  CartSnapshot,
  CheckoutOutcome,
  EngineAction,
  Observation,
  PlaceOrderResult,
  SerializedElement,
} from "./AutomationEngine";
import type { DomainEvent, DomainEventListener } from "./events";
import type { InAppBrowserBridge } from "./bridge";
import {
  buildSerializerScript,
  buildCheckoutProbeScript,
  type CheckoutProbeCandidate,
} from "./injected/domSerializer";
import { searchQueryFor } from "../adapters/playbooks/common";
import { parsePackSize } from "../pricing/packPricing";
import { buildSettleScript } from "./injected/settleWaiter";
import { buildActionScript } from "./injected/actionExecutor";
import {
  type AutomationTraceLevel,
  isAutomationDebug,
  traceAutomation,
} from "../debug/automationDebug";

/** Context handed to each playbook step. */
export interface PlaybookContext {
  readonly platform: PlatformId;
  readonly observation: Observation;
  readonly history: readonly EngineAction[];
  /** The requested item for search/read flows, if any. */
  readonly item?: RequestedItem;
  /** Mutable per-run scratchpad (e.g. skuId/qty for addToCart, idempotencyKey for placeOrder). */
  readonly state: Record<string, unknown>;
  /** How many consecutive failures have occurred so far on this step. */
  readonly attempt: number;
}

/** One step of a deterministic playbook: returns the next action, or null to defer to the backend. */
export type PlaybookStep = (ctx: PlaybookContext) => EngineAction | null;

export interface Playbook {
  readonly name: string;
  readonly steps: readonly PlaybookStep[];
}

export type PlaybookName =
  | "search"
  | "readProduct"
  | "setQuantity"
  | "addToCart"
  | "clearCart"
  | "checkout"
  | "placeOrder";

export type Playbooks = Partial<Record<PlaybookName, Playbook>>;

/** What a `readProduct` playbook/backend must produce via an `extract` action. */
export interface QuoteDraft {
  readonly skuId: string;
  readonly canonicalItemId?: string;
  readonly title: string;
  readonly pricePaise: number;
  readonly mrpPaise?: number;
  /** Explicit pack size (e.g. "1 Kg") when extraction knows it; else parsed from the title. */
  readonly packSize?: string;
  readonly inStock: boolean;
  /** Product detail-page URL (relative or absolute) the engine absolutises onto the Quote. */
  readonly productUrl?: string;
  readonly stockCap?: number;
  readonly deliveryDate?: string;
  readonly movPaise?: number;
  readonly deliveryFeePaise?: number;
}

/** What a `placeOrder` playbook/backend must produce via an `extract` action. */
export interface PlaceOrderDraft {
  readonly orderRef: string;
  readonly totalPaise: number;
  readonly paidOnCredit: boolean;
}

export interface WebViewAutomationEngineOptions {
  readonly platform: PlatformId;
  readonly bridge: InAppBrowserBridge;
  readonly backend: BackendClient;
  /** Logical webview id; defaults to the platform id. */
  readonly webviewId?: string;
  readonly playbooks?: Playbooks;
  /** Human-like inter-action delay (§3.5.10). Default is a no-op (0) for tests. */
  readonly delay?: () => Promise<void>;
  /** Backoff sleep used by retry. Default is a no-op for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Circuit-breaker threshold of consecutive failed actions. Default 3 (§3.5.10). */
  readonly maxConsecutiveFailures?: number;
  /** Per-action execution retries before counting a failure. Default 2. */
  readonly maxActionRetries?: number;
  /** Hard cap on loop iterations to guarantee termination. Default 60. */
  readonly maxLoopSteps?: number;
  /**
   * Max time (ms) to keep re-perceiving a product listing before `readProduct` extracts, while it shows
   * no price yet. SPA grids (Hyperpure) lazy-load tiles AFTER the route's network goes idle, so the
   * first perceive can catch the bare shell. Default 0 (off) so unit tests stay synchronous; production
   * sets a few seconds. Uses a real timer (independent of the no-op test `sleep`).
   */
  readonly listingSettleMs?: number;
  /**
   * Max time (ms) to keep re-perceiving a freshly-opened cart page before `clearCart`/`getCart` read it.
   * Amazon streams the cart body AFTER its settle/network-idle fires, so the first perceive can catch a
   * near-empty shell (~1 element / 146-byte DOM) — which silently fooled `clearCart` into reporting "cart
   * emptied" while the old items were still there, and made the Verifier read an empty cart. Default 0
   * (off) so unit tests stay synchronous; production sets a few seconds. Uses a real timer.
   */
  readonly cartLoadMs?: number;
  /**
   * When DOM extraction yields no quote in `readProduct`, capture a webview screenshot and ask the
   * backend's vision model to read the product. Off by default; enabled for platforms whose listing
   * DOM is too large to serialize reliably (Hyperpure). Requires `backend.visionExtract`.
   */
  readonly visionFallback?: boolean;
  /**
   * The platform's cart-page URL. `getCart` navigates here before reading, since after add-to-cart the
   * webview is parked on the last product page. When unset, `getCart` reads whatever page is open.
   */
  readonly cartUrl?: string;
  /**
   * Build a server-side "add to cart" URL from the CURRENT product-page URL + quantity, or return null
   * when it can't (so the engine falls back to clicking the page button). When set (Amazon), `addToCart`
   * navigates to it instead of clicking the page's add button — Amazon's mobile detail page double-loads
   * its own JS (`AUIDefineJS already present`, `sp.load.js already registered`), which kills the
   * client-side add handler so the click does nothing. The cart-add endpoint adds the exact quantity in
   * one server round-trip, honouring the logged-in session. Keeping the (Amazon-specific) ASIN parsing in
   * the builder leaves the engine platform-agnostic.
   */
  readonly cartAddUrl?: (currentUrl: string, qty: number) => string | null;
  /** Base backoff in ms; the nth retry waits base * 2^n. Default 200. */
  readonly baseBackoffMs?: number;
  /** Clock for `readAt`/timestamps. */
  readonly now?: () => string;
  readonly otpUrlPatterns?: readonly RegExp[];
  readonly paymentUrlPatterns?: readonly RegExp[];
  /** Reads the cart badge count from an observation; default heuristic looks for a "cart N" element. */
  readonly cartCountReader?: (obs: Observation) => number | null;
  /** Reads a full cart snapshot for the Verifier; default returns an empty cart. */
  readonly cartReader?: (obs: Observation, platform: PlatformId) => CartSnapshot;
}

/** Thrown when the circuit breaker trips after N consecutive failed actions (§3.5.10). */
export class CircuitBreakerError extends Error {
  readonly platform: PlatformId;
  readonly step: string;
  readonly failures: number;

  constructor(platform: PlatformId, step: string, failures: number) {
    super(
      `Circuit breaker tripped on "${platform}" during "${step}" after ${failures} consecutive failures`,
    );
    this.name = "CircuitBreakerError";
    this.platform = platform;
    this.step = step;
    this.failures = failures;
  }
}

interface HitlSignal {
  readonly kind: "otp" | "payment";
  readonly prompt: string;
  readonly amountPaise?: number;
}

type LoopResult =
  | { readonly kind: "done" }
  | { readonly kind: "extract"; readonly data: unknown }
  | { readonly kind: "hitl"; readonly hitl: HitlSignal };

interface RunLoopArgs {
  readonly stepName: string;
  readonly task: string;
  readonly playbook?: Playbook;
  readonly item?: RequestedItem;
  readonly state?: Record<string, unknown>;
}

const DEFAULT_OTP_URL_PATTERNS: readonly RegExp[] = [
  /\b(otp|verify|verification|signin|sign-in|login|auth)\b/i,
];

const DEFAULT_PAYMENT_URL_PATTERNS: readonly RegExp[] = [
  /\b(payment|checkout\/pay|razorpay|payu|upi|paytm|gpay)\b/i,
];

// "one-time" must be followed by code/password/pin to count as OTP — otherwise Amazon's ubiquitous
// "One-time purchase" (Subscribe & Save) on every product card false-trips an OTP wall and blocks reads.
const OTP_DOM_PATTERN = /\botp\b|one[-\s]?time[-\s]?(?:pass(?:word|code)|code|pin)\b|verification code|enter the code/i;
const PAYMENT_DOM_PATTERN =
  /\bpayment\b|pay now|proceed to pay|\bupi\b|card number|net\s?banking/i;
const CART_BADGE_PATTERN = /cart/i;
/**
 * Is `url` a single-PRODUCT detail page (not a home/search/listing/cart page)?
 *  - Amazon: `/dp/…`, `/gp/product/…`, `/gp/aw/d/…`.
 *  - Hyperpure: a single slug under `/in/` — `/in/milky-mist-paneer-1-kg` — but NOT `/in/search/…`,
 *    `/in/cart`, etc. (The old regex required `/in/<x>/<y>`, which wrongly matched `/in/search/paneer`
 *    and missed the real one-segment product URL — the reason checkout kept re-opening the search page.)
 */
function looksLikeProductUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  if (/\/(dp|gp\/product|gp\/aw\/d)\//i.test(url)) return true;
  const m = /hyperpure\.com\/in\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/i.exec(url);
  if (!m) return false;
  return !["search", "cart", "checkout", "account", "orders", "products"].includes(m[1].toLowerCase());
}

export class WebViewAutomationEngine implements AutomationEngine {
  readonly platform: PlatformId;

  private readonly bridge: InAppBrowserBridge;
  private readonly backend: BackendClient;
  private readonly webviewId: string;
  private readonly playbooks: Playbooks;
  private readonly delay: () => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxConsecutiveFailures: number;
  private readonly maxActionRetries: number;
  private readonly maxLoopSteps: number;
  private readonly listingSettleMs: number;
  private readonly cartLoadMs: number;
  private readonly visionFallback: boolean;
  private readonly cartUrl?: string;
  private readonly cartAddUrl?: (currentUrl: string, qty: number) => string | null;
  private readonly baseBackoffMs: number;
  private readonly now: () => string;
  private readonly otpUrlPatterns: readonly RegExp[];
  private readonly paymentUrlPatterns: readonly RegExp[];
  private readonly cartCountReader: (obs: Observation) => number | null;
  private readonly cartReader: (obs: Observation, platform: PlatformId) => CartSnapshot;

  private readonly listeners = new Set<DomainEventListener>();
  private hidden = true;
  private urlUnsubscribe?: () => void;
  /** Last observed page URL; used to absolutise product/cart hrefs read off the DOM. */
  private lastUrl = "";

  constructor(opts: WebViewAutomationEngineOptions) {
    this.platform = opts.platform;
    this.bridge = opts.bridge;
    this.backend = opts.backend;
    this.webviewId = opts.webviewId ?? opts.platform;
    this.playbooks = opts.playbooks ?? {};
    this.delay = opts.delay ?? (() => Promise.resolve());
    this.sleep = opts.sleep ?? ((_ms: number) => Promise.resolve());
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
    this.maxActionRetries = opts.maxActionRetries ?? 2;
    this.maxLoopSteps = opts.maxLoopSteps ?? 60;
    this.listingSettleMs = opts.listingSettleMs ?? 0;
    this.cartLoadMs = opts.cartLoadMs ?? 0;
    this.visionFallback = opts.visionFallback ?? false;
    this.cartUrl = opts.cartUrl;
    this.cartAddUrl = opts.cartAddUrl;
    this.baseBackoffMs = opts.baseBackoffMs ?? 200;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.otpUrlPatterns = opts.otpUrlPatterns ?? DEFAULT_OTP_URL_PATTERNS;
    this.paymentUrlPatterns = opts.paymentUrlPatterns ?? DEFAULT_PAYMENT_URL_PATTERNS;
    this.cartCountReader = opts.cartCountReader ?? defaultCartCountReader;
    this.cartReader = opts.cartReader ?? defaultCartReader;
  }

  // --- lifecycle -------------------------------------------------------------

  async open(url: string, opts?: { hidden?: boolean }): Promise<void> {
    this.hidden = opts?.hidden ?? true;
    this.trace("think", `open ${url} (hidden=${this.hidden})`);
    await this.bridge.open(this.webviewId, url, this.hidden);
    this.installUrlListener();
    await this.settle();
    this.trace("info", "page settled");
  }

  async close(): Promise<void> {
    if (this.urlUnsubscribe) {
      this.urlUnsubscribe();
      this.urlUnsubscribe = undefined;
    }
    await this.bridge.close(this.webviewId);
  }

  async show(): Promise<void> {
    await this.bridge.show(this.webviewId);
  }

  async hide(): Promise<void> {
    await this.bridge.hide(this.webviewId);
  }

  // --- low-level primitives (the BrowserSession surface for per-platform agents) ----------------
  // These expose the engine's perceive→act→screenshot loop so a PlatformAgent (AmazonAgent,
  // HyperpureAgent) can implement its own strategy (e.g. open the product detail page to read the
  // TRUE price, or click the native add-to-cart button) instead of being limited to the high-level
  // search/readProduct/addToCart playbook path.

  /** Serialize the current page into an {@link Observation} (public wrapper for agents). */
  async observe(): Promise<Observation> {
    return this.perceive();
  }

  /** Execute one action with the engine's retry/backoff and post-action settle. */
  async act(action: EngineAction): Promise<ActionResult> {
    const result = await this.executeWithRetry(action);
    // Let the page react (e.g. ADD → cart network round-trip + stepper swap) before the caller observes
    // to confirm the effect — otherwise a same-tick read sees the pre-click DOM and reports a false fail.
    if (result.ok) {
      try {
        await this.settle();
      } catch {
        /* best-effort: a settle timeout must not mask a successful action */
      }
    }
    return result;
  }

  /** Capture a webview screenshot as a data URL, or null on failure (never throws). */
  async captureScreenshot(): Promise<string | null> {
    try {
      return await this.bridge.screenshot(this.webviewId);
    } catch {
      return null;
    }
  }

  // --- public engine API -----------------------------------------------------

  async search(item: RequestedItem): Promise<void> {
    // Echo the FULL parsed item (not just name) so a wrong search query ("milky" instead of "paneer")
    // can be pinned to the intent parse vs. the query builder, straight from the on-device debug log.
    this.trace(
      "info",
      `search item: name="${item.name}" brand="${item.brand ?? ""}" variant="${item.variant ?? ""}"` +
        ` packSize="${item.packSize ?? ""}" qty=${item.qty} → query "${searchQueryFor(item)}"`,
    );
    await this.runLoop({
      stepName: "search",
      task: `search for "${item.name}"`,
      playbook: this.playbooks.search,
      item,
    });
  }

  async readProduct(item: RequestedItem): Promise<Quote> {
    const result = await this.runReadLoopSafe(item, `read the best product matching "${item.name}"`);
    let draft: QuoteDraft | undefined =
      result?.kind === "extract" && isQuoteDraft(result.data) ? result.data : undefined;
    if (!draft && this.visionFallback) {
      draft = await this.visionReadProduct(item);
    }
    if (!draft) {
      throw new Error(`readProduct(${item.name}): no quote could be read (DOM and vision both failed)`);
    }
    const quote = this.buildQuote(draft, item);
    this.emit({ type: "QuoteRead", platform: this.platform, quote });
    return quote;
  }

  /**
   * Run the perceive→settle→extract loop for a read, but NEVER let a tripped circuit breaker (or any
   * loop throw) abort the item: a thrown loop is swallowed so the caller can still attempt the vision
   * read on whatever page is showing. Returns `undefined` when the loop produced no usable result.
   */
  private async runReadLoopSafe(item: RequestedItem, task: string): Promise<LoopResult | undefined> {
    try {
      return await this.runLoop({
        stepName: "readProduct",
        task,
        playbook: this.playbooks.readProduct,
        item,
      });
    } catch (err) {
      this.trace(
        "warn",
        `read loop failed (${err instanceof Error ? err.message : String(err)}) → falling back to vision`,
      );
      return undefined;
    }
  }

  /**
   * Read a RANKED list of candidate products (best first). Runs the same settle+extract loop as
   * {@link readProduct} (so a virtualized listing renders), then asks the vision model for the top-N
   * matches; a DOM-extracted draft, when present, is the authoritative primary and vision candidates
   * fill the picker. Deduped by skuId. Falls back to a single {@link readProduct} when vision is off.
   */
  async readProductCandidates(item: RequestedItem): Promise<readonly Quote[]> {
    const result = await this.runReadLoopSafe(item, `read candidate products matching "${item.name}"`);
    const domDraft: QuoteDraft | undefined =
      result?.kind === "extract" && isQuoteDraft(result.data) ? result.data : undefined;
    const visionDrafts = this.visionFallback ? await this.visionReadCandidates(item) : [];

    const ordered: QuoteDraft[] = [];
    const seen = new Set<string>();
    for (const draft of [...(domDraft ? [domDraft] : []), ...visionDrafts]) {
      if (seen.has(draft.skuId)) continue;
      seen.add(draft.skuId);
      ordered.push(draft);
    }
    if (ordered.length === 0) {
      throw new Error(`readProductCandidates(${item.name}): no candidate products were extracted`);
    }
    const quotes = ordered.map((draft) => this.buildQuote(draft, item));
    // The primary read drives the optimizer; emit it as the canonical QuoteRead (same as readProduct).
    this.emit({ type: "QuoteRead", platform: this.platform, quote: quotes[0] });
    return quotes;
  }

  async addToCart(skuId: string, qty: number): Promise<void> {
    // Debug-only: dump the REAL quantity/add-to-cart/stepper identifiers on this product page so we can
    // wire precise selectors against the site's actual DOM (the lean perceiver drops id/class).
    await this.traceCheckoutProbe();

    // Preferred path (Amazon): add via the server-side cart-add endpoint instead of the detail page's
    // "Add to cart" button, whose handler is dead because the mobile page double-loads its own JS. This
    // adds the EXACT quantity in one navigation and honours the logged-in session. The Verifier re-reads
    // the real cart afterwards, so a failed/blocked add (out-of-stock, 3P seller) is still caught.
    if (this.cartAddUrl && (await this.addViaCartUrl(skuId, qty))) return;

    // Prefer setting the product-page quantity selector to the full count in one shot (Amazon's
    // `<select name="quantity">`). One "Add to cart" then adds all N at once — reliable even when the
    // cart badge is hidden. Platforms with only a +/- stepper have no selector, so this is a no-op and
    // the badge-watching loop below adds one at a time instead.
    if (qty > 1 && this.playbooks.setQuantity) {
      const r = await this.runLoop({
        stepName: "setQuantity",
        task: `set the quantity to ${qty}`,
        playbook: this.playbooks.setQuantity,
        state: { skuId, qty },
      });
      if (r.kind === "hitl") return;
    }

    const before = await this.perceive();
    const beforeCount = this.cartCountReader(before);
    // Best-effort reach the requested quantity by adding one at a time and watching the cart badge:
    // on tiles with a +/- stepper each click increments; on a product page the first click adds it.
    // We can only *measure* progress when the badge is readable — otherwise we add once and trust the
    // Verifier (which re-reads the real cart) to catch any shortfall, never inventing a quantity.
    const target = beforeCount != null ? beforeCount + qty : null;
    const maxRounds = Math.max(1, Math.min(qty, 12)) + 2;
    let count = beforeCount ?? 0;
    let stalled = 0;
    for (let round = 0; round < maxRounds; round++) {
      const result = await this.runLoop({
        stepName: "addToCart",
        task: `add "${skuId}" to the cart`,
        playbook: this.playbooks.addToCart,
        state: { skuId, qty, remaining: target != null ? target - count : qty },
      });
      if (result.kind === "hitl") return;

      const after = await this.perceive();
      const afterCount = this.cartCountReader(after);
      if (afterCount != null) {
        if (afterCount <= count) stalled++;
        else stalled = 0;
        count = afterCount;
      }
      // Stop when we've reached the target, when the badge isn't measurable (single best-effort add),
      // or when two rounds make no progress (the page can't be advanced further automatically).
      if (target == null) {
        count = beforeCount != null ? beforeCount + 1 : count;
        break;
      }
      if (count >= target || stalled >= 2) break;
    }
    this.trace(
      "info",
      `addToCart "${skuId}" → cart count ${count}` +
        (target != null ? ` (target ${target})` : " (badge unreadable)"),
    );
    this.emit({
      type: "ItemAddedToCart",
      platform: this.platform,
      skuId,
      qty,
      cartCount: count,
    });
  }

  /**
   * Amazon-only fast path: add the item via the server-side cart-add endpoint built from the current
   * product URL (e.g. `/gp/aws/cart/add.html?ASIN.1=<ASIN>&Quantity.1=<qty>`). Returns true when it
   * navigated there (the add was attempted server-side), false when no URL could be built (no ASIN on the
   * current page) so the caller falls back to clicking. After navigating, some locales show a tiny
   * confirmation page with a final "Add to cart" button — we click it if present. Verification still
   * happens later in `getCart`, so this never *asserts* success, it just uses the reliable mechanism.
   */
  private async addViaCartUrl(skuId: string, qty: number): Promise<boolean> {
    if (!this.cartAddUrl) return false;
    // Capture the current product URL (the detail page CheckoutDriver just opened).
    const here = (await this.perceive()).url || this.lastUrl;
    const url = this.cartAddUrl(here, qty);
    if (!url) {
      this.trace("warn", `addToCart "${skuId}": no cart-add URL for ${here || "(unknown)"} — using button`);
      return false;
    }
    this.trace("think", `addToCart "${skuId}" → cart-add URL (qty ${qty})`);
    await this.open(url, { hidden: this.hidden });
    // The endpoint adds the item server-side and lands on the cart; perceive once so `lastUrl`/state are
    // current, but do NOT click anything (avoids deferring to Claude on a page with no add button). The
    // Verifier re-reads the real cart next, which is the source of truth for whether the add stuck.
    await this.perceive();
    this.trace("info", `addToCart "${skuId}" → added via cart-add URL (qty ${qty}); Verifier will confirm`);
    this.emit({ type: "ItemAddedToCart", platform: this.platform, skuId, qty, cartCount: qty });
    return true;
  }

  async getCart(): Promise<CartSnapshot> {
    // The cart is read on a dedicated cart page; after add-to-cart the webview is parked on the last
    // product page, so navigate to the cart first (preserving the current shown/hidden state).
    if (this.cartUrl) {
      try {
        await this.open(this.cartUrl, { hidden: this.hidden });
      } catch (e) {
        this.trace("warn", `getCart: could not open cart page ${this.cartUrl}: ${String(e)}`);
      }
    }
    // Wait for the cart body to actually stream in — perceiving the bare shell would read an empty cart
    // and fail verification even when add-to-cart succeeded.
    const obs = await this.awaitCartLoaded();
    const cart = this.cartReader(obs, this.platform);
    this.traceCartDiag(obs, cart);
    // Also dump the cart page's quantity/remove controls — the cart-page stepper is our fallback for
    // setting quantity when the product page has no native selector.
    await this.traceCheckoutProbe();
    return cart;
  }

  /**
   * Real-timer poll until a freshly-opened cart page has actually rendered. Amazon returns the cart URL's
   * settle/ready while the body is still a ~1-element shell (the 146-byte DOM that fooled `clearCart`),
   * then streams the real contents a beat later. We re-perceive until the DOM has a meaningful element
   * count or `cartLoadMs` elapses. Bounded, and a no-op in tests (`cartLoadMs` defaults to 0 → one
   * perceive, no waiting).
   */
  private async awaitCartLoaded(): Promise<Observation> {
    let obs = await this.perceive();
    if (this.cartLoadMs <= 0) return obs;
    const start = Date.now();
    let polls = 0;
    while (obs.elements.length < CART_LOADED_MIN_ELEMENTS && Date.now() - start < this.cartLoadMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      obs = await this.perceive();
      polls++;
    }
    if (polls > 0) {
      this.trace(
        "info",
        `cart-load: ${polls} poll(s) → ${obs.elements.length} elements` +
          (obs.elements.length < CART_LOADED_MIN_ELEMENTS ? " (still bare — read may be unreliable)" : ""),
      );
    }
    return obs;
  }

  /**
   * Empty the cart before we add the approved lines, so verification compares OUR items against a clean
   * cart instead of whatever was left from a previous session. Navigates to the cart page, then removes
   * one line per round until the cart reads empty or a round makes no progress (so a stuck "Delete"
   * control can never spin forever). A HITL boundary (re-login) aborts cleanly.
   */
  async clearCart(): Promise<void> {
    if (!this.playbooks.clearCart) return;
    if (this.cartUrl) {
      try {
        await this.open(this.cartUrl, { hidden: this.hidden });
      } catch (e) {
        this.trace("warn", `clearCart: could not open cart page ${this.cartUrl}: ${String(e)}`);
        return;
      }
    }
    // Track the FEWEST lines we've seen and a stall counter rather than breaking the instant a round
    // doesn't strictly improve: deleting a line makes Amazon reload the cart, and the immediately-next
    // read can transiently show the same (or more) lines mid-render. Breaking on the first non-decrease
    // is what made clearCart give up after removing a single item. We keep going until the cart is empty,
    // no progress is made for several consecutive rounds, or we hit the hard round cap.
    let best = Number.POSITIVE_INFINITY;
    let stalled = 0;
    for (let round = 0; round < 24; round++) {
      // Wait for the cart body to render: perceiving the bare shell reads 0 lines and would make us
      // declare the cart "emptied" while the old items are still there (exactly the bug seen in the
      // field — clearCart logged "emptied" then the cart still held a bag + a book).
      const obs = await this.awaitCartLoaded();
      const remaining = this.cartReader(obs, this.platform).lines.length;
      if (remaining === 0) {
        // Only trust "empty" once the page has actually loaded; a still-bare shell means we never saw the
        // real cart, so do not claim success (the Verifier will catch any leftover items).
        if (obs.elements.length >= CART_LOADED_MIN_ELEMENTS) {
          this.trace("info", "clearCart → cart emptied");
        } else {
          this.trace("warn", "clearCart: cart page did not render — leaving items, will rely on Verifier");
        }
        return;
      }
      if (remaining < best) {
        best = remaining;
        stalled = 0;
      } else {
        stalled++;
      }
      if (stalled >= 3) {
        this.trace("warn", `clearCart: ${remaining} item(s) left but no progress for 3 rounds — stopping`);
        break;
      }
      const result = await this.runLoop({
        stepName: "clearCart",
        task: "remove one item from the cart",
        playbook: this.playbooks.clearCart,
      });
      if (result.kind === "hitl") return;
    }
    this.trace("info", `clearCart → done (${best === Number.POSITIVE_INFINITY ? "?" : best} item(s) last seen)`);
  }

  async checkout(): Promise<CheckoutOutcome> {
    const obs = await this.perceive();
    const hitl = this.detectHitl(obs);
    if (hitl) return this.toCheckoutOutcome(await this.handleHitl(hitl));

    if (this.playbooks.checkout) {
      const result = await this.runLoop({
        stepName: "checkout",
        task: "proceed to checkout",
        playbook: this.playbooks.checkout,
      });
      if (result.kind === "hitl") return this.toCheckoutOutcome(result.hitl);
      if (result.kind === "extract" && isCheckoutOutcome(result.data)) {
        return result.data;
      }
    }
    return { kind: "credit_ok", amountPaise: 0 };
  }

  async placeOrder(idempotencyKey: string): Promise<PlaceOrderResult> {
    const result = await this.runLoop({
      stepName: "placeOrder",
      task: "place the order",
      playbook: this.playbooks.placeOrder,
      state: { idempotencyKey },
    });
    if (result.kind !== "extract" || !isPlaceOrderDraft(result.data)) {
      throw new Error("placeOrder: no order confirmation was extracted");
    }
    const placed: PlaceOrderResult = {
      orderRef: result.data.orderRef,
      totalPaise: result.data.totalPaise,
      paidOnCredit: result.data.paidOnCredit,
    };
    this.emit({
      type: "OrderPlaced",
      platform: this.platform,
      orderRef: placed.orderRef,
      totalPaise: placed.totalPaise,
      paidOnCredit: placed.paidOnCredit,
    });
    return placed;
  }

  on(listener: DomainEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Perceive the current page and heuristically decide whether it's a login wall. */
  async detectLoginWall(): Promise<boolean> {
    const obs = await this.perceive();
    const wall = looksLikeLoginWall(obs);
    this.trace(wall ? "warn" : "info", `login-wall check → ${wall ? "needs sign-in" : "looks authenticated"}`);
    return wall;
  }

  // --- verification ----------------------------------------------------------

  /**
   * Did the action produce the change we expected (§3.5.6)? Generic heuristics: cart badge
   * incremented, results/url advanced, or the input now holds the typed value. A no-op (identical
   * before/after) returns false so the loop retries / falls back / trips.
   */
  verifyStepEffect(
    before: Observation,
    after: Observation,
    action: EngineAction,
  ): boolean {
    switch (action.type) {
      case "type": {
        const el = findByIdx(after, action.idx);
        if (el && el.value != null) {
          return el.value === action.value || el.value.includes(action.value);
        }
        return observationsDiffer(before, after);
      }
      case "select": {
        const el = findByIdx(after, action.idx);
        if (el && el.value != null) return el.value === action.value;
        return observationsDiffer(before, after);
      }
      case "scroll":
        return after.scroll.y !== before.scroll.y;
      case "click":
      case "navigate": {
        if (after.url !== before.url) return true;
        const cb = this.cartCountReader(before);
        const ca = this.cartCountReader(after);
        if (cb != null && ca != null && ca > cb) return true;
        return observationsDiffer(before, after);
      }
      default:
        return true;
    }
  }

  // --- core loop -------------------------------------------------------------

  private async runLoop(args: RunLoopArgs): Promise<LoopResult> {
    const history: EngineAction[] = [];
    const state = args.state ?? {};
    const steps = args.playbook?.steps ?? [];
    let stepIndex = 0;
    let consecutiveFailures = 0;
    let forceBackend = false;

    this.trace("think", `▶ ${args.stepName}: ${args.task}`);

    for (let iter = 0; iter < this.maxLoopSteps; iter++) {
      let before = await this.perceive();
      this.trace(
        "info",
        `perceive #${iter}: ${before.url || "(blank)"} · ${before.elements.length} elements`,
      );
      // Listings lazy-load priced tiles after route-change network-idle, so the first readProduct
      // perceive can see only the page shell. Re-perceive until prices appear (bounded) before extract.
      if (iter === 0 && args.stepName === "readProduct" && this.listingSettleMs > 0) {
        before = await this.settleListing(before, args.item);
      }
      if (iter === 0 && isAutomationDebug() && args.item) {
        this.traceExtractionCandidates(before, args.item);
      }

      const hitl = this.detectHitl(before);
      if (hitl) {
        this.trace("warn", `human needed: ${hitl.kind}`);
        return { kind: "hitl", hitl: await this.handleHitl(hitl) };
      }

      let action: EngineAction | null = null;
      let fromBackend = false;
      if (!forceBackend && stepIndex < steps.length) {
        const step = steps[stepIndex];
        action = step({
          platform: this.platform,
          observation: before,
          history,
          item: args.item,
          state,
          attempt: consecutiveFailures,
        });
      }
      if (action === null) {
        // Vision-first read: when the playbook can't act on a `readProduct` step AND a vision fallback
        // exists, DON'T burn Claude grounding calls. On price-less SPA listings (Hyperpure) grounding
        // can't read the DOM and tends to navigate to the homepage — blanking the very results we want
        // to screenshot, then tripping the circuit breaker (the "2nd item never sourced" regression).
        // End the loop here so the caller runs the vision read on THIS settled listing instead.
        if (this.visionFallback && args.stepName === "readProduct") {
          this.trace("think", "↳ no DOM extract; using vision read (skipping Claude grounding)");
          return { kind: "done" };
        }
        this.trace("think", forceBackend ? "↳ self-heal: asking Claude" : "↳ playbook deferred: asking Claude");
        action = await this.backend.nextAction({
          platform: this.platform,
          task: args.task,
          observation: scrubObservation(before),
          history,
        });
        fromBackend = true;
      }
      this.trace("think", `plan(${fromBackend ? "Claude" : "playbook"}): ${describeAction(action)}`);

      if (action.type === "done") {
        this.trace("info", `✓ ${args.stepName} complete`);
        return { kind: "done" };
      }
      if (action.type === "fail") {
        return await this.tripCircuit(args.stepName, action.reason);
      }
      if (action.type === "extract") {
        this.trace("info", `extract: ${describeExtract(action.data)}`);
        history.push(action);
        return { kind: "extract", data: action.data };
      }
      if (action.type === "needs_human") {
        this.trace("warn", `human needed: ${action.kind}`);
        return {
          kind: "hitl",
          hitl: await this.handleHitl({ kind: action.kind, prompt: action.prompt }),
        };
      }

      const result = await this.executeWithRetry(action);
      history.push(action);
      const after = await this.perceive();
      const verified = result.ok && this.verifyStepEffect(before, after, action);
      this.trace(
        verified ? "info" : "warn",
        `act ${action.type} → exec=${result.ok ? "ok" : `fail(${result.reason ?? "?"})`} · verified=${verified}`,
      );

      if (!verified) {
        consecutiveFailures++;
        if (consecutiveFailures >= this.maxConsecutiveFailures) {
          return await this.tripCircuit(
            args.stepName,
            result.reason ?? "step-effect-not-verified",
          );
        }
        // Self-heal: defer the next attempt to the Claude-grounded backend (§3.5.7).
        this.trace("warn", `not verified (${consecutiveFailures}/${this.maxConsecutiveFailures}) → self-heal next`);
        forceBackend = true;
        continue;
      }

      consecutiveFailures = 0;
      forceBackend = false;
      stepIndex++;
      await this.delay();

      if (steps.length > 0 && stepIndex >= steps.length) {
        this.trace("info", `✓ ${args.stepName} complete (playbook exhausted)`);
        return { kind: "done" };
      }
    }

    return await this.tripCircuit(args.stepName, "max-loop-steps-exceeded");
  }

  private async executeWithRetry(action: EngineAction): Promise<ActionResult> {
    let last: ActionResult = { ok: false, reason: "not-executed" };
    for (let attempt = 0; attempt <= this.maxActionRetries; attempt++) {
      last = await this.executeAction(action);
      if (last.ok) return last;
      if (attempt < this.maxActionRetries) {
        await this.sleep(this.baseBackoffMs * 2 ** attempt);
      }
    }
    return last;
  }

  private async executeAction(action: EngineAction): Promise<ActionResult> {
    if (action.type === "navigate") {
      await this.bridge.open(this.webviewId, action.url, this.hidden);
      await this.settle();
      return { ok: true };
    }
    // click/type/select mutate the page — flag them so the bridge never blindly re-injects them after a
    // mid-action reload (which could double-apply the effect, e.g. add the same item twice).
    const mutating =
      action.type === "click" || action.type === "type" || action.type === "select";
    const detail = await this.bridge.call(
      this.webviewId,
      (rid) => buildActionScript(rid, action),
      { mutating },
    );
    await this.settle();
    return {
      ok: detail.ok === true,
      reason: typeof detail.reason === "string" ? detail.reason : undefined,
    };
  }

  private async tripCircuit(step: string, reason: string): Promise<never> {
    this.trace("error", `✗ ${step} failed: ${reason}`);
    let screenshotRef: string | undefined;
    try {
      screenshotRef = await this.bridge.screenshot(this.webviewId);
    } catch {
      screenshotRef = undefined;
    }
    this.emit({
      type: "StepFailed",
      platform: this.platform,
      step,
      reason,
      ...(screenshotRef ? { screenshotRef } : {}),
    });
    throw new CircuitBreakerError(this.platform, step, this.maxConsecutiveFailures);
  }

  // --- perception ------------------------------------------------------------

  private async perceive(): Promise<Observation> {
    const detail = await this.bridge.call(this.webviewId, (rid) =>
      buildSerializerScript(rid),
    );
    const obs = coerceObservation(detail);
    if (obs.url) this.lastUrl = obs.url;
    return obs;
  }

  /**
   * Find the product detail URL for the chosen product `title` by reading the current listing DOM: pick
   * the product anchor (`<a href>`) whose href is a product page AND whose href-slug / link text overlaps
   * the title the most. Matching on the slug ("milky-mist-paneer-1-kg") is robust even when the anchor has
   * no text (image-only tile). Returns undefined (best-effort) so a failure never breaks the read.
   */
  private async findProductUrlForTitle(title: string): Promise<string | undefined> {
    const tokens = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    if (tokens.length === 0) return undefined;
    let obs: Observation;
    try {
      obs = await this.perceive();
    } catch {
      return undefined;
    }
    let bestHref: string | undefined;
    let bestScore = 0;
    for (const el of obs.elements) {
      const abs = this.absoluteUrl(el.attrs?.href ?? undefined);
      if (!abs || !looksLikeProductUrl(abs)) continue;
      const hay = `${el.name ?? ""} ${abs}`.toLowerCase();
      const score = tokens.reduce((s, t) => (hay.includes(t) ? s + 1 : s), 0);
      if (score > bestScore) {
        bestScore = score;
        bestHref = abs;
      }
    }
    // Require at least a couple of token hits so we don't latch onto an unrelated product link.
    return bestScore >= Math.min(2, tokens.length) ? bestHref : undefined;
  }

  /** Resolve a relative/absolute href against the last observed page URL (best-effort). */
  private absoluteUrl(href: string | undefined): string | undefined {
    if (!href) return undefined;
    try {
      return new URL(href, this.lastUrl || undefined).toString();
    } catch {
      return /^https?:\/\//i.test(href) ? href : undefined;
    }
  }

  private async settle(): Promise<void> {
    await this.bridge.call(this.webviewId, (rid) => buildSettleScript(rid));
  }

  // --- HITL detection & hand-off (§3.5.9) ------------------------------------

  private installUrlListener(): void {
    if (this.urlUnsubscribe) return;
    this.urlUnsubscribe = this.bridge.addUrlChangeListener((url) => {
      void this.onUrlChange(url);
    });
  }

  private async onUrlChange(url: string): Promise<void> {
    for (const re of this.otpUrlPatterns) {
      if (re.test(url)) {
        await this.handleHitl({ kind: "otp", prompt: otpPrompt(this.platform) });
        return;
      }
    }
    for (const re of this.paymentUrlPatterns) {
      if (re.test(url)) {
        await this.handleHitl({
          kind: "payment",
          prompt: paymentPrompt(this.platform),
          amountPaise: 0,
        });
        return;
      }
    }
  }

  private detectHitl(obs: Observation): HitlSignal | null {
    for (const re of this.otpUrlPatterns) {
      if (re.test(obs.url)) return { kind: "otp", prompt: otpPrompt(this.platform) };
    }
    for (const re of this.paymentUrlPatterns) {
      if (re.test(obs.url)) {
        return { kind: "payment", prompt: paymentPrompt(this.platform), amountPaise: 0 };
      }
    }
    for (const el of obs.elements) {
      const haystack = `${el.name} ${el.attrs.name ?? ""}`;
      if (OTP_DOM_PATTERN.test(haystack)) {
        return { kind: "otp", prompt: otpPrompt(this.platform) };
      }
    }
    for (const el of obs.elements) {
      if (PAYMENT_DOM_PATTERN.test(el.name)) {
        return { kind: "payment", prompt: paymentPrompt(this.platform), amountPaise: 0 };
      }
    }
    return null;
  }

  private async handleHitl(hitl: HitlSignal): Promise<HitlSignal> {
    if (hitl.kind === "otp") {
      this.emit({ type: "NeedsOtp", platform: this.platform, prompt: hitl.prompt });
    } else {
      this.emit({
        type: "NeedsPayment",
        platform: this.platform,
        amountPaise: hitl.amountPaise ?? 0,
        prompt: hitl.prompt,
      });
    }
    await this.show();
    return hitl;
  }

  private toCheckoutOutcome(hitl: HitlSignal): CheckoutOutcome {
    if (hitl.kind === "otp") return { kind: "needs_otp", prompt: hitl.prompt };
    return {
      kind: "needs_payment",
      amountPaise: hitl.amountPaise ?? 0,
      prompt: hitl.prompt,
    };
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Fallback read: screenshot the (rendered) webview and have the backend's vision model read the
   * best-matching product. For SPA listings whose DOM is too large to serialize over the bridge, the
   * page paints fine, so a screenshot carries the price where the DOM does not. Returns undefined on
   * any failure so the caller treats the item as unsourced (never invents a price).
   */
  private async visionReadProduct(item: RequestedItem): Promise<QuoteDraft | undefined> {
    const drafts = await this.visionReadCandidates(item);
    return drafts[0];
  }

  /**
   * Vision read returning the RANKED candidate list (best first). One screenshot, then the backend
   * reads up to N matching products; each is mapped to a {@link QuoteDraft} with its own detail-page
   * URL resolved straight off the listing DOM ({@link findProductUrlForTitle}) so checkout/picker can
   * open the exact product. Older backends that return only the scalar single product degrade to a
   * one-element list. Returns `[]` on any failure (caller treats the item as unsourced — never a
   * fabricated price).
   */
  private async visionReadCandidates(item: RequestedItem): Promise<QuoteDraft[]> {
    if (!this.backend.visionExtract) return [];
    let restoreHidden = false;
    try {
      // A screenshot needs a rendered (shown) webview; reveal briefly if we're scraping hidden.
      if (this.hidden) {
        await this.bridge.show(this.webviewId);
        restoreHidden = true;
      }
      // The readProduct loop scrolls the grid down hunting for priced tiles, which can leave the
      // viewport parked on empty space below the results — yielding a near-blank screenshot the model
      // can't read. Scroll back to the top (best matches sit in the first rows) before the shot.
      try {
        await this.executeAction({ type: "scroll", dy: -1_000_000 });
      } catch {
        /* best-effort: a failed scroll must not abort the vision read */
      }
      const dataUrl = await this.bridge.screenshot(this.webviewId);
      const img = parseDataUrl(dataUrl);
      if (!img) {
        this.trace("warn", `vision-extract: no screenshot captured (dataUrl len=${(dataUrl ?? "").length})`);
        return [];
      }
      // Device-side evidence: a too-small payload means the webview wasn't painted/revealed in time
      // (blank capture) — distinct from a valid screenshot the model simply couldn't read. A real
      // Hyperpure listing screenshot is ~1MB of base64; anything tiny is almost certainly blank.
      const level = img.base64.length < BLANK_SCREENSHOT_BASE64_LEN ? "warn" : "info";
      this.trace(
        level,
        `vision-extract: captured ${img.mimeType} base64Len=${img.base64.length}` +
          (level === "warn" ? " (looks blank — webview may not have painted)" : ""),
      );
      const res = await this.backend.visionExtract({
        platform: this.platform,
        item,
        imageBase64: img.base64,
        mimeType: img.mimeType,
      });
      // Prefer the ranked `candidates` list; fall back to the scalar single product for older backends.
      const raw =
        res.candidates && res.candidates.length > 0
          ? res.candidates
          : res.found && typeof res.pricePaise === "number" && res.title
            ? [
                {
                  skuId: res.skuId,
                  title: res.title,
                  pricePaise: res.pricePaise,
                  mrpPaise: res.mrpPaise,
                  inStock: res.inStock,
                },
              ]
            : [];
      if (raw.length === 0) {
        this.trace("info", `vision-extract: no matching product in screenshot for "${item.name}"`);
        return [];
      }
      const drafts: QuoteDraft[] = [];
      const seen = new Set<string>();
      for (const c of raw) {
        if (typeof c.pricePaise !== "number" || !c.title) continue;
        const skuId = c.skuId ?? slugify(c.title);
        if (seen.has(skuId)) continue;
        seen.add(skuId);
        // Capture each candidate's detail-page URL straight off the listing DOM (the user's ask: "save
        // the product details page URL from the search result while choosing the right product"). On a
        // search listing the screenshot has no single URL, but the matching tile is an
        // <a href="/in/…slug"> we can read — so checkout/picker opens that product directly.
        const productUrl =
          (await this.findProductUrlForTitle(c.title)) ??
          (looksLikeProductUrl(this.lastUrl) ? this.lastUrl : undefined);
        drafts.push({
          skuId,
          canonicalItemId: canonicalIdOf(item),
          title: c.title,
          pricePaise: c.pricePaise,
          mrpPaise: c.mrpPaise,
          inStock: c.inStock ?? true,
          productUrl,
        });
      }
      if (drafts.length > 0) {
        const top = drafts[0];
        this.trace(
          "info",
          `vision-extract → ${drafts.length} candidate(s); top "${top.title}" ` +
            `₹${(top.pricePaise / 100).toFixed(2)} inStock=${top.inStock}` +
            (top.productUrl ? ` · ${top.productUrl}` : ""),
        );
      }
      return drafts;
    } catch (e) {
      this.trace("warn", `vision-extract failed: ${String(e)}`);
      return [];
    } finally {
      if (restoreHidden) {
        try {
          await this.bridge.hide(this.webviewId);
        } catch {
          /* best-effort restore */
        }
      }
    }
  }

  private buildQuote(draft: QuoteDraft, item: RequestedItem): Quote {
    return {
      platform: this.platform,
      skuId: draft.skuId,
      canonicalItemId: draft.canonicalItemId ?? canonicalIdOf(item),
      title: draft.title,
      pricePaise: draft.pricePaise,
      mrpPaise: draft.mrpPaise,
      // Pack size drives the ₹/kg comparison + the default platform pick. Prefer an explicit value
      // from extraction; otherwise parse it out of the product title ("Milky Mist Paneer, 1 Kg").
      packSize: draft.packSize ?? parsePackSize(draft.title)?.raw,
      inStock: draft.inStock,
      productUrl: this.absoluteUrl(draft.productUrl),
      stockCap: draft.stockCap,
      deliveryDate: draft.deliveryDate,
      movPaise: draft.movPaise,
      deliveryFeePaise: draft.deliveryFeePaise,
      readAt: this.now(),
    };
  }

  private emit(event: DomainEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Debug trace scoped to this platform (no-op unless automation debug is enabled). */
  private trace(level: AutomationTraceLevel, message: string): void {
    traceAutomation(level, message, this.platform);
  }

  /**
   * Poll-perceive a product listing until priced tiles render, or `listingSettleMs` elapses. Targets
   * SPA grids (Hyperpure) whose tiles appear a beat after the route's network goes idle — the moment
   * the bridge's settle heuristic fires. Uses a real timer so it works in production (where the engine
   * `sleep` is a no-op) and is skipped entirely in tests (`listingSettleMs` defaults to 0).
   */
  private async settleListing(initial: Observation, item?: RequestedItem): Promise<Observation> {
    let obs = initial;
    const stepMs = 700;
    const start = Date.now();
    let polls = 0;
    // Wait for a priced tile that actually matches the item — not promo banners ("Starting ₹449"),
    // which carry a price but never the queried product, and would otherwise end the wait too early.
    while (!hasPricedItem(obs, item) && Date.now() - start < this.listingSettleMs) {
      // Hyperpure's results grid is virtualized: tiles only mount as they scroll into view, so a static
      // wait never renders them. Nudge the grid down a modest step each poll to hydrate the first rows.
      try {
        await this.executeAction({ type: "scroll", dy: 500 });
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
      }
      obs = await this.perceive();
      polls++;
    }
    if (polls > 0) {
      this.trace(
        "info",
        `listing-settle: ${polls} poll(s) → matched=${hasPricedItem(obs, item)} · ${obs.elements.length} elements`,
      );
    }
    return obs;
  }

  /**
   * Debug-only evidence dump for the extraction layer: shows how many elements carry a price, whether
   * any element matches the requested item's name, and a sample of both. This is what lets us tune the
   * selectors (`findResultCard` / `parsePricePaise`) against the site's REAL DOM instead of guessing —
   * e.g. it reveals when the price lives outside the matched `<a>` or past the 120-char name cap.
   */
  private traceExtractionCandidates(obs: Observation, item: RequestedItem): void {
    const PRICE = /(?:₹|rs\.?|inr)\s*[\d,]/i;
    const nameNeedle = item.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
    const priced = obs.elements.filter((el) => PRICE.test(`${el.name} ${el.value ?? ""}`));
    const named = obs.elements.filter((el) => {
      const t = `${el.name} ${el.attrs.name ?? ""} ${el.attrs.href ?? ""}`.toLowerCase();
      return nameNeedle.length > 0 && nameNeedle.every((n) => t.includes(n));
    });
    const both = named.filter((el) => PRICE.test(el.name));
    this.trace(
      "info",
      `extract-diag "${item.name}": priced=${priced.length} named=${named.length} named+priced=${both.length}`,
    );
    const sample = (el: SerializedElement): string =>
      `[${el.idx}] ${el.tag}${el.role ? `/${el.role}` : ""} "${el.name.slice(0, 80)}"${el.attrs.href ? ` href=${el.attrs.href.slice(0, 40)}` : ""}`;
    for (const el of named.slice(0, 4)) this.trace("info", `  named ${sample(el)}`);
    for (const el of priced.slice(0, 4)) this.trace("info", `  priced ${sample(el)}`);
    // When tiles are named but carry no recognized currency (priced=0), the price is likely rendered as
    // bare digits (rupee glyph via CSS/icon). Dump digit-bearing nodes so we can see the REAL price markup
    // and tune the extractor against it instead of guessing.
    if (both.length === 0 && named.length > 0) {
      const digity = obs.elements.filter((el) => /\d/.test(el.name) && el.name.length <= 40);
      this.trace("info", `extract-diag digit-nodes: ${digity.length}`);
      for (const el of digity.slice(0, 12)) this.trace("info", `  digit ${sample(el)}`);
    }
  }

  /**
   * Device-side evidence for the cart read: logs how many lines the reader recovered and a sample of
   * product-link rows on the page, so a verify "missing SKU" can be debugged against the REAL cart DOM
   * (the reader is heuristic; this trace is how we tune its selectors without guessing).
   */
  /**
   * Debug-only: run the checkout probe and log each candidate's real identifiers (id / class / name /
   * type / text). This is the evidence we need to build a robust `findQuantitySelector` / `findAddToCart`
   * for Amazon's mobile detail page (where there is no native `<select name="quantity">` and our script
   * re-injection corrupts the styled add-to-cart handler). Best-effort: never throws into the add flow.
   */
  private async traceCheckoutProbe(): Promise<void> {
    if (!isAutomationDebug()) return;
    try {
      const detail = await this.bridge.call(this.webviewId, (rid) =>
        buildCheckoutProbeScript(rid),
      );
      const candidates = Array.isArray((detail as { candidates?: unknown }).candidates)
        ? ((detail as { candidates: CheckoutProbeCandidate[] }).candidates)
        : [];
      this.trace("info", `checkout-probe: ${candidates.length} candidate control(s)`);
      for (const c of candidates) {
        this.trace(
          "info",
          `  [${c.group}] <${c.tag}> id="${c.id}" name="${c.nameAttr}" type="${c.type}"` +
            ` val="${c.value}" idx=${c.idx || "-"} aria="${c.aria}" cls="${c.cls.slice(0, 70)}" text="${c.text}"`,
        );
      }
    } catch (e) {
      this.trace("warn", `checkout-probe failed: ${String(e)}`);
    }
  }

  private traceCartDiag(obs: Observation, cart: CartSnapshot): void {
    if (!isAutomationDebug()) return;
    this.trace(
      "info",
      `cart-diag: url=${obs.url || "(blank)"} · ${obs.elements.length} elements · reader found ${cart.lines.length} line(s)`,
    );
    for (const line of cart.lines.slice(0, 6)) {
      this.trace(
        "info",
        `  cart-line ${line.skuId} ×${line.qty} @ ${(line.unitPricePaise / 100).toFixed(2)} "${line.title.slice(0, 60)}"`,
      );
    }
    if (cart.lines.length === 0) {
      const links = obs.elements
        .filter((el) => (el.tag === "a" || el.role === "link") && (el.attrs.href ?? "").length > 0)
        .slice(0, 10);
      this.trace("warn", `cart-diag: 0 lines parsed — sample links on page (tune readCartLines):`);
      for (const el of links) {
        this.trace(
          "info",
          `  link [${el.idx}] "${el.name.slice(0, 50)}" href=${(el.attrs.href ?? "").slice(0, 60)}`,
        );
      }
    }
  }
}

// --- module-level pure helpers -----------------------------------------------

const PRICE_TEXT_RE = /(?:₹|rs\.?|inr)\s*[\d,]/i;

/**
 * Below this base64 length a webview screenshot is almost certainly blank (a painted Hyperpure listing
 * is ~1MB of base64; an empty/early capture is tens of KB). Used purely to flag the likely cause in the
 * trace, not to fail — the vision model still gets a fair shot at whatever was captured.
 */
const BLANK_SCREENSHOT_BASE64_LEN = 60_000;

/** Count elements whose text carries a price — a proxy for "the product grid has rendered". */
function countPricedElements(obs: Observation): number {
  let n = 0;
  for (const el of obs.elements) {
    if (PRICE_TEXT_RE.test(`${el.name} ${el.value ?? ""}`)) n++;
  }
  return n;
}

/**
 * Whether the listing shows a priced tile for the requested item — the real "grid has rendered" signal.
 * An element whose visible name contains the item name and either carries a price inline or sits in the
 * same column as a priced element (title/price are sibling nodes). Promo banners fail this (no item).
 */
const UNIT_PRICE_RE = /(?:₹|rs\.?|inr)[\s\d.,]*\/\s*(?:kg|gm?|pc|pcs|piece|pack|ltr|l|ml)\b/i;

/**
 * Min serialized-element count for a cart page to be considered "rendered" (vs. a not-yet-streamed shell).
 * A blank Amazon cart shell serializes to ~1 element (the 146-byte DOM seen in the field); even an EMPTY
 * but loaded cart carries the site header/footer/nav (dozens of elements), so 40 cleanly separates the
 * two without waiting on a genuinely-empty cart.
 */
const CART_LOADED_MIN_ELEMENTS = 40;

function hasPricedItem(obs: Observation, item?: RequestedItem): boolean {
  // A per-unit price ("₹121/kg") appears only on real product tiles — never on promo banners or price
  // filters — so it's the cleanest "the grid has rendered" signal.
  const hasUnitPrice = obs.elements.some((el) => UNIT_PRICE_RE.test(el.name));
  if (!item) return hasUnitPrice || countPricedElements(obs) > 0;
  const token = item.name.trim().toLowerCase();
  if (token.length === 0) return hasUnitPrice || countPricedElements(obs) > 0;
  const hasItemName = obs.elements.some((el) => el.name.toLowerCase().includes(token));
  if (hasItemName && hasUnitPrice) return true;
  // Fallback: the item title sits in the same column as a price element (sibling title/price nodes).
  const priced = obs.elements.filter((el) => PRICE_TEXT_RE.test(el.name));
  return obs.elements.some((el) => {
    if (!el.name.toLowerCase().includes(token)) return false;
    if (PRICE_TEXT_RE.test(el.name)) return true;
    return priced.some((p) => {
      const dx = Math.abs(p.bbox[0] - el.bbox[0]);
      const dy = p.bbox[1] - el.bbox[1];
      return dx <= 220 && dy >= -120 && dy <= 360;
    });
  });
}

function findByIdx(obs: Observation, idx: number): SerializedElement | undefined {
  return obs.elements.find((el) => el.idx === idx);
}

/**
 * The on-device {@link RequestedItem} carries a `canonicalItemId` at runtime (the backend `/intent`
 * and `/plan` responses include it) even though the TS type omits it. The optimizer maps quotes to
 * demand by this id — which the backend normalizes to lowercase-no-spaces (e.g. "spring onion" →
 * "springonion") — so a quote MUST be stamped with it, not the spaced display name, or multi-word
 * items never match and surface as "could not source". Fall back to the display name when absent.
 */
function canonicalIdOf(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

/** Split a `data:<mime>;base64,<payload>` URL into its media type and raw base64 payload. */
function parseDataUrl(dataUrl: string): { base64: string; mimeType: string } | undefined {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUrl ?? "");
  if (!m) return undefined;
  const base64 = m[2] ?? "";
  if (!base64) return undefined;
  return { base64, mimeType: m[1] || "image/png" };
}

/** Stable SKU id from a title (no href available from a screenshot). */
function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  return out.slice(0, 64) || "vision-sku";
}

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|account\/(login|signin))\b/i;
const SIGNIN_PROMPT_RE = /\b(log\s?in|sign\s?in|continue with (otp|phone|mobile|google|email)|enter (otp|mobile|phone))\b/i;
const SIGNIN_HREF_RE = /\/(ap\/signin|signin|sign-in|login|account\/(login|signin))\b/i;
// A genuine "sign out" affordance only renders once authenticated — the strongest logged-in signal.
const SIGNOUT_RE = /\b(log\s?out|sign\s?out)\b/i;

/**
 * Heuristic login-wall detector. We deliberately do NOT treat "your account" / "hello," / "wishlist"
 * as proof of being logged in: those render on logged-OUT pages too (e.g. Amazon shows a "your
 * account" link and a "Hello, sign in" greeting that both deep-link to /ap/signin), which previously
 * produced a false "authenticated" verdict. Instead:
 *  - a real "sign out" affordance ⇒ authenticated (not a wall);
 *  - otherwise any sign-in PROMPT text, or a link/button pointing at a sign-in URL, ⇒ a wall.
 * The debug trace logs the decision so it can be tuned per platform.
 */
export function looksLikeLoginWall(obs: Observation): boolean {
  if (LOGIN_URL_RE.test(obs.url)) return true;
  let signInHits = 0;
  let signOutHits = 0;
  for (const el of obs.elements) {
    const text = `${el.name} ${el.value ?? ""}`;
    const href = el.attrs.href ?? "";
    if (SIGNOUT_RE.test(text)) signOutHits++;
    if (SIGNIN_PROMPT_RE.test(text) || SIGNIN_HREF_RE.test(href)) signInHits++;
  }
  if (signOutHits > 0) return false;
  return signInHits > 0;
}

/** One-line, PII-free description of an action for the debug trace. */
function describeAction(action: EngineAction): string {
  switch (action.type) {
    case "navigate":
      return `navigate → ${action.url}`;
    case "type":
      return `type @${action.idx} "${action.value}"`;
    case "select":
      return `select @${action.idx} "${action.value}"`;
    case "click":
      return `click @${action.idx}`;
    case "scroll":
      return "scroll";
    default:
      return action.type;
  }
}

/** Short summary of extracted data (keys only) for the debug trace. */
function describeExtract(data: unknown): string {
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o.pricePaise === "number") {
      return `quote ${o.title ?? o.skuId ?? ""} @ ${o.pricePaise}p inStock=${o.inStock}`;
    }
    return Object.keys(o).join(",");
  }
  return String(data);
}

function observationSignature(obs: Observation): string {
  const els = obs.elements
    .map((e) => `${e.idx}:${e.tag}:${e.role ?? ""}:${e.name}:${e.value ?? ""}`)
    .join("~");
  return `${obs.url}|${obs.title}|${obs.scroll.y}|${els}`;
}

function observationsDiffer(before: Observation, after: Observation): boolean {
  return observationSignature(before) !== observationSignature(after);
}

function defaultCartCountReader(obs: Observation): number | null {
  for (const el of obs.elements) {
    if (!CART_BADGE_PATTERN.test(el.name)) continue;
    const match = el.name.match(/(\d+)/);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function defaultCartReader(_obs: Observation, platform: PlatformId): CartSnapshot {
  return { platform, lines: [], subtotalPaise: 0 };
}

function coerceObservation(detail: Record<string, unknown>): Observation {
  const elements = Array.isArray(detail.elements)
    ? (detail.elements as SerializedElement[])
    : [];
  const scroll =
    detail.scroll && typeof detail.scroll === "object"
      ? (detail.scroll as { y?: unknown; h?: unknown; vh?: unknown })
      : {};
  return {
    url: typeof detail.url === "string" ? detail.url : "",
    title: typeof detail.title === "string" ? detail.title : "",
    scroll: {
      y: toNumber(scroll.y),
      h: toNumber(scroll.h),
      vh: toNumber(scroll.vh),
    },
    elements,
  };
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\+?\d[\d ()-]{8,}\d/g;
const TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const SHORT_CODE_RE = /\b\d{4,8}\b/g;

function scrubText(value: string): string {
  return value
    .replace(EMAIL_RE, "[email]")
    .replace(TOKEN_RE, "[token]")
    .replace(PHONE_RE, "[phone]")
    .replace(SHORT_CODE_RE, "[code]");
}

/** Strip emails/phones/OTP-like/token-like strings before sending an observation off-device (§3.5.3). */
function scrubObservation(obs: Observation): Observation {
  return {
    url: obs.url,
    title: obs.title,
    scroll: obs.scroll,
    elements: obs.elements.map((el) => ({
      ...el,
      name: scrubText(el.name),
      value: el.value != null ? scrubText(el.value) : null,
      attrs: {
        ...el.attrs,
        href: el.attrs.href != null ? scrubText(el.attrs.href) : el.attrs.href,
      },
    })),
  };
}

function isQuoteDraft(data: unknown): data is QuoteDraft {
  if (!data || typeof data !== "object") return false;
  const o = data as Record<string, unknown>;
  return (
    typeof o.skuId === "string" &&
    typeof o.title === "string" &&
    typeof o.pricePaise === "number" &&
    typeof o.inStock === "boolean"
  );
}

function isPlaceOrderDraft(data: unknown): data is PlaceOrderDraft {
  if (!data || typeof data !== "object") return false;
  const o = data as Record<string, unknown>;
  return (
    typeof o.orderRef === "string" &&
    typeof o.totalPaise === "number" &&
    typeof o.paidOnCredit === "boolean"
  );
}

function isCheckoutOutcome(data: unknown): data is CheckoutOutcome {
  if (!data || typeof data !== "object") return false;
  const o = data as Record<string, unknown>;
  if (o.kind === "needs_otp") return typeof o.prompt === "string";
  if (o.kind === "needs_payment") {
    return typeof o.prompt === "string" && typeof o.amountPaise === "number";
  }
  if (o.kind === "credit_ok") return typeof o.amountPaise === "number";
  return false;
}

function otpPrompt(platform: PlatformId): string {
  return `Enter the OTP ${platform} just sent you to continue.`;
}

function paymentPrompt(platform: PlatformId): string {
  return `Complete the payment on ${platform} to place this order.`;
}

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
import { buildSerializerScript } from "./injected/domSerializer";
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
  | "addToCart"
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
  readonly inStock: boolean;
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
  private readonly baseBackoffMs: number;
  private readonly now: () => string;
  private readonly otpUrlPatterns: readonly RegExp[];
  private readonly paymentUrlPatterns: readonly RegExp[];
  private readonly cartCountReader: (obs: Observation) => number | null;
  private readonly cartReader: (obs: Observation, platform: PlatformId) => CartSnapshot;

  private readonly listeners = new Set<DomainEventListener>();
  private hidden = true;
  private urlUnsubscribe?: () => void;

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

  // --- public engine API -----------------------------------------------------

  async search(item: RequestedItem): Promise<void> {
    await this.runLoop({
      stepName: "search",
      task: `search for "${item.name}"`,
      playbook: this.playbooks.search,
      item,
    });
  }

  async readProduct(item: RequestedItem): Promise<Quote> {
    const result = await this.runLoop({
      stepName: "readProduct",
      task: `read the best product matching "${item.name}"`,
      playbook: this.playbooks.readProduct,
      item,
    });
    if (result.kind !== "extract") {
      throw new Error(`readProduct(${item.name}): no quote was extracted`);
    }
    if (!isQuoteDraft(result.data)) {
      throw new Error(`readProduct(${item.name}): extracted data is not a valid quote`);
    }
    const quote = this.buildQuote(result.data, item);
    this.emit({ type: "QuoteRead", platform: this.platform, quote });
    return quote;
  }

  async addToCart(skuId: string, qty: number): Promise<void> {
    const before = await this.perceive();
    const beforeCount = this.cartCountReader(before);

    const result = await this.runLoop({
      stepName: "addToCart",
      task: `add ${qty} of "${skuId}" to the cart`,
      playbook: this.playbooks.addToCart,
      state: { skuId, qty },
    });
    if (result.kind === "hitl") return;

    const after = await this.perceive();
    const afterCount = this.cartCountReader(after);
    const cartCount = afterCount ?? (beforeCount ?? 0) + 1;
    this.emit({
      type: "ItemAddedToCart",
      platform: this.platform,
      skuId,
      qty,
      cartCount,
    });
  }

  async getCart(): Promise<CartSnapshot> {
    const obs = await this.perceive();
    return this.cartReader(obs, this.platform);
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
    const detail = await this.bridge.call(this.webviewId, (rid) =>
      buildActionScript(rid, action),
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
    return coerceObservation(detail);
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

  private buildQuote(draft: QuoteDraft, item: RequestedItem): Quote {
    return {
      platform: this.platform,
      skuId: draft.skuId,
      canonicalItemId: draft.canonicalItemId ?? item.name,
      title: draft.title,
      pricePaise: draft.pricePaise,
      mrpPaise: draft.mrpPaise,
      inStock: draft.inStock,
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
  }
}

// --- module-level pure helpers -----------------------------------------------

const PRICE_TEXT_RE = /(?:₹|rs\.?|inr)\s*[\d,]/i;

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

const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|account\/(login|signin))\b/i;
const LOGIN_WORD_RE = /\b(log\s?in|sign\s?in|continue with (otp|phone|mobile|google|email)|enter (otp|mobile|phone))\b/i;
const LOGGED_IN_RE = /\b(log\s?out|sign\s?out|my orders|my account|your account|hello[, ]|account &|wishlist)\b/i;

/**
 * Heuristic login-wall detector: a login page either lives at a login URL, or shows sign-in prompts
 * while showing none of the usual logged-in affordances (logout / my account / orders). Imperfect by
 * nature — the debug trace logs the decision so it can be tuned per platform.
 */
function looksLikeLoginWall(obs: Observation): boolean {
  if (LOGIN_URL_RE.test(obs.url)) return true;
  let loginHits = 0;
  let loggedInHits = 0;
  for (const el of obs.elements) {
    const text = `${el.name} ${el.value ?? ""}`;
    if (LOGIN_WORD_RE.test(text)) loginHits++;
    if (LOGGED_IN_RE.test(text)) loggedInHits++;
  }
  return loginHits > 0 && loggedInHits === 0;
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

/**
 * Deterministic, in-memory {@link AutomationEngine} used ONLY by the `?demo=1` test seam of
 * {@link ProcureFlow} (and by e2e/unit tests). It never touches a real WebView, the Capgo bridge, or
 * a network — so the full Chat → quote → optimize → approve → checkout → summary journey can run in a
 * plain browser (Playwright/Chromium), which cannot host a Capacitor WebView.
 *
 * It does NOT change the agent core: the real {@link Orchestrator} state machine, the
 * {@link CheckoutDriver}, the {@link VerifierClient} safety gate, and the live `/intent`, `/plan`,
 * `/optimize`, `/verify` backend calls all run unchanged. Demo mode only swaps the automation
 * transport for this deterministic stand-in.
 *
 * Behaviour:
 *  - `readProduct` returns a canned in-stock quote per item. Items are priced so that consecutive
 *    items win on alternating platforms (item 0 cheapest on Hyperpure, item 1 on Amazon, …), which
 *    guarantees the optimizer produces a genuine multi-platform split with a visible saving.
 *  - `getCart` mirrors the approved per-platform allocation, so the real Verifier passes.
 *  - `checkout` emits a `needs_otp` then a `needs_payment` outcome (driving the OTP/payment hand-off
 *    screens) before reporting `credit_ok`, then `placeOrder` returns a deterministic confirmation.
 */
import type {
  AutomationEngine,
  CartSnapshot,
  CheckoutOutcome,
  PlaceOrderResult,
} from "../AutomationEngine";
import type { DomainEvent, DomainEventListener } from "../events";
import type {
  Allocation,
  PlatformId,
  Quote,
  RequestedItem,
} from "../../domain/types";

/** Unit price (paise) a platform charges when it is the cheaper option for an item. */
const DEMO_CHEAP_PAISE = 9000;
/** Unit price (paise) a platform charges when it is the dearer option for an item. */
const DEMO_DEAR_PAISE = 12000;

export interface MockAutomationEngineOptions {
  readonly platform: PlatformId;
  /**
   * Reads the current optimizer allocation so checkout can present a cart that exactly matches the
   * human-approved plan (the real Verifier still runs and must pass).
   */
  readonly getAllocation: () => Allocation | null;
  /** Injectable clock for deterministic timestamps. */
  readonly now?: () => string;
}

export class MockAutomationEngine implements AutomationEngine {
  readonly platform: PlatformId;

  private readonly getAllocation: () => Allocation | null;
  private readonly now: () => string;
  private readonly listeners = new Set<DomainEventListener>();

  /** Index of the next item to be read this run; resets on `open`. Drives the alternating split. */
  private readIndex = 0;
  /** Which checkout round we are on; resets on `open`. 0 → OTP, 1 → payment, ≥2 → credit_ok. */
  private checkoutPhase = 0;

  constructor(opts: MockAutomationEngineOptions) {
    this.platform = opts.platform;
    this.getAllocation = opts.getAllocation;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // --- lifecycle (no-ops; resets per-run counters) ---------------------------

  async open(_url: string, _opts?: { hidden?: boolean }): Promise<void> {
    this.readIndex = 0;
    this.checkoutPhase = 0;
  }

  async close(): Promise<void> {}
  async show(): Promise<void> {}
  async hide(): Promise<void> {}

  // --- quoting ---------------------------------------------------------------

  async search(_item: RequestedItem): Promise<void> {}

  async readProduct(item: RequestedItem): Promise<Quote> {
    const index = this.readIndex++;
    const canonicalItemId = canonicalIdOf(item);
    // Both platform engines read items in the same order, so a given index refers to the same item
    // on both — alternating the cheaper platform by index guarantees a real cross-platform split.
    const cheaperPlatform: PlatformId = index % 2 === 0 ? "hyperpure" : "amazon";
    const pricePaise =
      this.platform === cheaperPlatform ? DEMO_CHEAP_PAISE : DEMO_DEAR_PAISE;

    const quote: Quote = {
      platform: this.platform,
      skuId: `${this.platform}-${canonicalItemId}`,
      canonicalItemId,
      title: `${item.name} (${this.platform})`,
      pricePaise,
      inStock: true,
      movPaise: 0,
      deliveryFeePaise: 0,
      readAt: this.now(),
    };
    this.emit({ type: "QuoteRead", platform: this.platform, quote });
    return quote;
  }

  async addToCart(_skuId: string, _qty: number): Promise<void> {}

  async getCart(): Promise<CartSnapshot> {
    const lines = this.myAllocationLines();
    const subtotalPaise = lines.reduce(
      (sum, line) => sum + line.unitPricePaise * line.qty,
      0,
    );
    return {
      platform: this.platform,
      lines: lines.map((line) => ({
        skuId: line.skuId,
        title: line.itemName,
        qty: line.qty,
        unitPricePaise: line.unitPricePaise,
      })),
      subtotalPaise,
    };
  }

  // --- checkout: OTP → payment → credit_ok -----------------------------------

  async checkout(): Promise<CheckoutOutcome> {
    const phase = this.checkoutPhase++;
    if (phase === 0) {
      return {
        kind: "needs_otp",
        prompt: `Enter the OTP ${this.platform} just sent you to continue.`,
      };
    }
    if (phase === 1) {
      return {
        kind: "needs_payment",
        amountPaise: this.myTotalPaise(),
        prompt: `Complete the payment on ${this.platform} to place this order.`,
      };
    }
    return { kind: "credit_ok", amountPaise: 0 };
  }

  async placeOrder(_idempotencyKey: string): Promise<PlaceOrderResult> {
    return {
      orderRef: `${this.platform.toUpperCase()}-DEMO-0001`,
      totalPaise: this.myTotalPaise(),
      paidOnCredit: true,
    };
  }

  on(listener: DomainEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- helpers ---------------------------------------------------------------

  private myAllocationLines() {
    return (
      this.getAllocation()?.perPlatform.find((p) => p.platform === this.platform)
        ?.lines ?? []
    );
  }

  private myTotalPaise(): number {
    return (
      this.getAllocation()?.perPlatform.find((p) => p.platform === this.platform)
        ?.totalPaise ?? 0
    );
  }

  private emit(event: DomainEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * The on-device {@link RequestedItem} carries a `canonicalItemId` at runtime (the backend `/intent`
 * and `/plan` responses include it) even though the TS type omits it. Mirror it onto the quote so the
 * optimizer can map quotes to demand; fall back to the display name.
 */
function canonicalIdOf(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

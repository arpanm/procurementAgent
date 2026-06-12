/**
 * The checkout driver (PROCURE_COPILOT_PLAN.md §6 core loop, Epic 6). Given an approved
 * {@link PlatformAllocation}, it runs the safe checkout sequence for one platform:
 *
 *   1. read the cart (`engine.getCart`)
 *   2. VERIFY cart-vs-plan ({@link VerifierClient}) — STOP on mismatch, never checkout/place
 *   3. `engine.checkout()`; on `needs_otp` / `needs_payment` reveal the live webview (`engine.show()`)
 *      and PAUSE for the human (`awaitHuman()`), then re-check — the agent NEVER auto-fills OTP/payment
 *   4. on `credit_ok`, `engine.placeOrder(key)` under an idempotency guard (no double-order on retry)
 *   5. parse the confirmation, emit `OrderPlaced`, write the audit trail
 *
 * Safety invariants encoded here:
 *  - There is NO code path that types into an OTP or payment field. The driver only ever calls the
 *    high-level engine methods (`getCart`/`checkout`/`show`/`placeOrder`); HITL is delegated to a real
 *    human via `awaitHuman()`.
 *  - Checkout cannot proceed when the Verifier reports a mismatch.
 *  - Order placement is idempotent: a retry with the same key returns the original result and emits no
 *    duplicate `OrderPlaced`.
 *
 * Domain events are emitted through `onEvent` (wire `orchestrator.ingest` here to fold them into the
 * session machine).
 */
import type {
  AutomationEngine,
  CheckoutOutcome,
} from "../automation/AutomationEngine";
import type { BackendClient } from "../backend/BackendClient";
import type { DomainEvent, DomainEventListener } from "../automation/events";
import type {
  OrderAttempt,
  PlatformAllocation,
  PlatformId,
  RequestedItem,
} from "../domain/types";
import type { AuditLog } from "../audit/AuditLog";
import { InMemorySecureStore } from "../secure/SecureStore";
import { VerifierClient } from "./VerifierClient";
import { IdempotencyStore, newIdempotencyKey } from "./idempotency";
import { parseOrderConfirmation } from "./OrderConfirmationParser";

/** Upper bound on checkout re-checks, so a misbehaving site can never spin forever. */
const MAX_CHECKOUT_ROUNDS = 12;

export interface CheckoutDriverDeps {
  readonly engine: AutomationEngine;
  readonly backend: BackendClient;
  readonly audit: AuditLog;
  /**
   * The originally-requested items, keyed for re-search when filling the cart. Phase 1 only READ
   * prices (nothing is added pre-approval), so before verifying we must add each approved line to the
   * cart; re-searching by the original item (brand/variant/pack) re-locates the same product. When an
   * item isn't supplied for a line, we still attempt {@code addToCart} on whatever page is open.
   */
  readonly items?: readonly RequestedItem[];
  /**
   * Product detail-page URLs captured while pricing, keyed by `canonicalItemId`. When present for a
   * line, checkout re-opens the exact product page and adds it from there (far more reliable than
   * re-searching), per the approved "open the product link directly and add to cart" flow.
   */
  readonly productUrls?: ReadonlyMap<string, string>;
  /** Keep the webview visible during cart-fill (debug). Defaults to hidden automation. */
  readonly showWebView?: boolean;
  /**
   * The platform's cart URL, surfaced to the user for manual review + checkout after {@link stageCart}
   * stages the items. When set, the staged {@link OrderAttempt} carries it so the summary can offer a
   * "Review & checkout on {platform}" hand-off.
   */
  readonly cartUrl?: string;
  /** Sink for domain events; wire `orchestrator.ingest` to fold them into the session. */
  readonly onEvent?: DomainEventListener;
  /** Override the verifier (e.g. with a price tolerance); defaults to one wrapping `backend`. */
  readonly verifier?: VerifierClient;
  /** Override the idempotency guard; defaults to an in-memory-backed one. */
  readonly idempotency?: IdempotencyStore;
  /**
   * The human-resume hook: resolves when the user taps "Done" after entering OTP / completing payment.
   * Called once per HITL pause. Defaults to immediate resolution (only safe in tests with no HITL).
   */
  readonly awaitHuman?: () => Promise<void>;
  /** Injectable clock for deterministic timestamps. */
  readonly now?: () => string;
}

export class CheckoutDriver {
  private readonly engine: AutomationEngine;
  private readonly audit: AuditLog;
  private readonly itemsById: ReadonlyMap<string, RequestedItem>;
  private readonly productUrls: ReadonlyMap<string, string>;
  private readonly showWebView: boolean;
  private readonly cartUrl?: string;
  private readonly onEvent?: DomainEventListener;
  private readonly verifier: VerifierClient;
  private readonly idempotency: IdempotencyStore;
  private readonly awaitHuman: () => Promise<void>;
  private readonly now: () => string;

  constructor(deps: CheckoutDriverDeps) {
    this.engine = deps.engine;
    this.audit = deps.audit;
    this.itemsById = new Map(
      (deps.items ?? []).map((item) => [canonicalIdOf(item), item] as const),
    );
    this.productUrls = deps.productUrls ?? new Map();
    this.showWebView = deps.showWebView ?? false;
    this.cartUrl = deps.cartUrl;
    this.onEvent = deps.onEvent;
    this.verifier = deps.verifier ?? new VerifierClient(deps.backend);
    this.idempotency =
      deps.idempotency ?? new IdempotencyStore(new InMemorySecureStore());
    this.awaitHuman = deps.awaitHuman ?? (() => Promise.resolve());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private emit(event: DomainEvent): void {
    this.onEvent?.(event);
  }

  /** Run the safe checkout sequence for one platform's allocation. */
  async run(allocation: PlatformAllocation): Promise<OrderAttempt> {
    const platform = allocation.platform;
    const startedAt = this.now();
    const idempotencyKey = newIdempotencyKey(platform, allocation);

    await this.audit.append({
      actor: "agent",
      action: "checkout:start",
      after: { platform, totalPaise: allocation.totalPaise, idempotencyKey },
      at: startedAt,
    });

    try {
      // 0a. Empty any pre-existing cart items so verification compares the approved lines against a
      // clean cart (and we don't accidentally check out someone's leftover items). Best-effort: a
      // platform engine without cart-clearing support (or a stubbed test engine) simply skips this.
      if (this.engine.clearCart) {
        try {
          await this.engine.clearCart();
          await this.audit.append({
            actor: "agent",
            action: "cart:clear",
            after: { platform },
            at: this.now(),
          });
        } catch (clearErr) {
          await this.audit.append({
            actor: "agent",
            action: "cart:clear-failed",
            after: {
              platform,
              reason: clearErr instanceof Error ? clearErr.message : String(clearErr),
            },
            at: this.now(),
          });
        }
      }

      // 0b. Fill the cart with the approved lines. Phase 1 only READ prices (we never add to a cart
      // before the human approves), so the cart is empty here. We re-open the exact product detail page
      // captured while pricing and add it from there; if no URL is known, fall back to re-searching the
      // original item. Per-line failures are non-fatal — the Verifier below is the gate and will surface
      // anything missing rather than letting us check out a wrong cart.
      for (const line of allocation.lines) {
        try {
          const productUrl = this.productUrls.get(line.canonicalItemId);
          if (productUrl) {
            await this.engine.open(productUrl, { hidden: !this.showWebView });
          } else {
            const item = this.itemsById.get(line.canonicalItemId);
            if (item) await this.engine.search(item);
          }
          await this.engine.addToCart(line.skuId, line.qty);
          await this.audit.append({
            actor: "agent",
            action: "cart:add",
            after: { platform, skuId: line.skuId, qty: line.qty, via: productUrl ? "product-url" : "search" },
            at: this.now(),
          });
        } catch (addErr) {
          await this.audit.append({
            actor: "agent",
            action: "cart:add-failed",
            after: {
              platform,
              skuId: line.skuId,
              reason: addErr instanceof Error ? addErr.message : String(addErr),
            },
            at: this.now(),
          });
        }
      }

      // 1. Read the cart.
      const cart = await this.engine.getCart();
      await this.audit.append({
        actor: "agent",
        action: "cart:read",
        after: { platform, lines: cart.lines, subtotalPaise: cart.subtotalPaise },
        at: this.now(),
      });

      // 2. VERIFY — the safety gate. STOP on any mismatch; never checkout or place.
      const verdict = await this.verifier.assertCartMatches(cart, allocation.lines);
      if (!verdict.ok) {
        const reason = `Cart does not match the approved plan: ${verdict.mismatches.join(" ")}`;
        await this.audit.append({
          actor: "agent",
          action: "verify:failed",
          after: { platform, mismatches: verdict.mismatches },
          at: this.now(),
        });
        this.emit({ type: "StepFailed", platform, step: "verify", reason });
        return this.failedAttempt(platform, allocation, idempotencyKey, startedAt);
      }
      await this.audit.append({
        actor: "agent",
        action: "verify:ok",
        after: { platform },
        at: this.now(),
      });

      // 3. Checkout, pausing for the human at every OTP / payment gate.
      let outcome = await this.engine.checkout();
      for (let round = 0; ; round++) {
        if (round >= MAX_CHECKOUT_ROUNDS) {
          const reason = `Checkout did not reach a terminal state after ${MAX_CHECKOUT_ROUNDS} rounds.`;
          await this.audit.append({
            actor: "agent",
            action: "checkout:stuck",
            after: { platform },
            at: this.now(),
          });
          this.emit({ type: "StepFailed", platform, step: "checkout", reason });
          return this.failedAttempt(platform, allocation, idempotencyKey, startedAt);
        }

        if (outcome.kind === "credit_ok") {
          break;
        }
        outcome = await this.handleHumanGate(platform, outcome);
      }

      // 4. Place the order under the idempotency guard, emitting OrderPlaced only on a real placement.
      const placement = await this.idempotency.withIdempotency(idempotencyKey, async () => {
        const result = await this.engine.placeOrder(idempotencyKey);
        const parsed = parseOrderConfirmation({ result });
        const orderRef = parsed.orderRef ?? result.orderRef;
        await this.audit.append({
          actor: "agent",
          action: "order:placed",
          after: {
            platform,
            orderRef,
            totalPaise: result.totalPaise,
            paidOnCredit: result.paidOnCredit,
          },
          at: this.now(),
        });
        this.emit({
          type: "OrderPlaced",
          platform,
          orderRef,
          totalPaise: result.totalPaise,
          paidOnCredit: result.paidOnCredit,
        });
        return { ...result, orderRef };
      });

      return {
        platform,
        status: "placed",
        totalPaise: placement.totalPaise,
        paidOnCredit: placement.paidOnCredit,
        orderRef: placement.orderRef,
        idempotencyKey,
        startedAt,
        updatedAt: this.now(),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.audit.append({
        actor: "agent",
        action: "checkout:error",
        after: { platform, reason },
        at: this.now(),
      });
      this.emit({ type: "StepFailed", platform, step: "checkout", reason });
      return this.failedAttempt(platform, allocation, idempotencyKey, startedAt);
    }
  }

  /**
   * Stage-only checkout (cart hand-off mode). Best-effort adds each approved line to the platform's
   * cart, then STOPS — no cart-clearing (we never touch the user's pre-existing items), no Verifier,
   * no OTP/payment automation, no order placement. The returned attempt carries the platform cart URL
   * so the summary can hand the user a "Review & checkout on {platform}" button to finish manually.
   *
   * This deliberately trades full automation (fragile on Amazon's cart) for a reliable, low-surprise
   * flow: the agent finds the product and drops it in your cart; you review quantity/variant and pay.
   */
  async stageCart(allocation: PlatformAllocation): Promise<OrderAttempt> {
    const platform = allocation.platform;
    const startedAt = this.now();
    const idempotencyKey = newIdempotencyKey(platform, allocation);

    await this.audit.append({
      actor: "agent",
      action: "cart:stage-start",
      after: { platform, lines: allocation.lines.length, idempotencyKey },
      at: startedAt,
    });

    let added = 0;
    for (const line of allocation.lines) {
      try {
        const productUrl = this.productUrls.get(line.canonicalItemId);
        if (productUrl) {
          await this.engine.open(productUrl, { hidden: !this.showWebView });
        } else {
          const item = this.itemsById.get(line.canonicalItemId);
          if (item) await this.engine.search(item);
        }
        await this.engine.addToCart(line.skuId, line.qty);
        added += 1;
        await this.audit.append({
          actor: "agent",
          action: "cart:add",
          after: { platform, skuId: line.skuId, qty: line.qty, via: productUrl ? "product-url" : "search" },
          at: this.now(),
        });
      } catch (addErr) {
        await this.audit.append({
          actor: "agent",
          action: "cart:add-failed",
          after: {
            platform,
            skuId: line.skuId,
            reason: addErr instanceof Error ? addErr.message : String(addErr),
          },
          at: this.now(),
        });
      }
    }

    await this.audit.append({
      actor: "agent",
      action: "cart:staged",
      after: { platform, added, total: allocation.lines.length, cartUrl: this.cartUrl },
      at: this.now(),
    });

    return {
      platform,
      status: "cart_filled",
      totalPaise: allocation.totalPaise,
      paidOnCredit: false,
      idempotencyKey,
      startedAt,
      updatedAt: this.now(),
      cartUrl: this.cartUrl,
      stagedLineCount: added,
    };
  }

  /**
   * Surface the live webview and pause for the human at an OTP / payment gate, then re-check checkout.
   * This is the ONLY place the flow handles OTP/payment — and it does so by handing control to a real
   * human (`show()` + `awaitHuman()`), never by typing into a field.
   */
  private async handleHumanGate(
    platform: PlatformId,
    outcome: Extract<CheckoutOutcome, { kind: "needs_otp" | "needs_payment" }>,
  ): Promise<CheckoutOutcome> {
    if (outcome.kind === "needs_otp") {
      await this.audit.append({
        actor: "agent",
        action: "otp:requested",
        after: { platform, prompt: outcome.prompt },
        at: this.now(),
      });
      this.emit({ type: "NeedsOtp", platform, prompt: outcome.prompt });
    } else {
      await this.audit.append({
        actor: "agent",
        action: "payment:requested",
        after: { platform, amountPaise: outcome.amountPaise, prompt: outcome.prompt },
        at: this.now(),
      });
      this.emit({
        type: "NeedsPayment",
        platform,
        amountPaise: outcome.amountPaise,
        prompt: outcome.prompt,
      });
    }

    // Reveal the real site and WAIT for the user to finish — no automation of OTP/payment.
    await this.engine.show();
    await this.awaitHuman();

    await this.audit.append({
      actor: "human",
      action: outcome.kind === "needs_otp" ? "otp:entered" : "payment:completed",
      after: { platform },
      at: this.now(),
    });

    // Re-check: the engine re-reads the page and reports the new state.
    return this.engine.checkout();
  }

  private failedAttempt(
    platform: PlatformId,
    allocation: PlatformAllocation,
    idempotencyKey: string,
    startedAt: string,
  ): OrderAttempt {
    return {
      platform,
      status: "failed",
      totalPaise: allocation.totalPaise,
      paidOnCredit: false,
      idempotencyKey,
      startedAt,
      updatedAt: this.now(),
    };
  }
}

/**
 * The on-device {@link RequestedItem} carries a `canonicalItemId` at runtime (the backend `/intent`
 * and `/plan` responses include it) even though the TS type omits it; the optimizer keys allocation
 * lines by it, so we map items by the same id to re-find a line's product. Falls back to the name.
 */
function canonicalIdOf(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

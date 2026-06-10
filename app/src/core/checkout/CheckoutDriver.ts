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
  private readonly onEvent?: DomainEventListener;
  private readonly verifier: VerifierClient;
  private readonly idempotency: IdempotencyStore;
  private readonly awaitHuman: () => Promise<void>;
  private readonly now: () => string;

  constructor(deps: CheckoutDriverDeps) {
    this.engine = deps.engine;
    this.audit = deps.audit;
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

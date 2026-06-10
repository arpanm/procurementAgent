/**
 * The AutomationEngine interface — the single seam that keeps the orchestrator unaware of *how* a
 * platform is driven (PROCURE_COPILOT_PLAN.md §3.1, §3.6.7). Today the only implementation is the
 * Capgo WebView engine (Epic 2); future implementations (other sites, Accessibility-driven native
 * apps, partner REST APIs) drop in without changing the agent core.
 */
import type { PlatformId, Quote, RequestedItem } from "../domain/types";
import type { DomainEvent, DomainEventListener } from "./events";

/** Low-level page observation passed to the grounding model (§3.5.4). */
export interface SerializedElement {
  readonly idx: number;
  readonly tag: string;
  readonly role: string | null;
  readonly name: string;
  readonly value: string | null;
  readonly bbox: readonly [number, number, number, number];
  readonly attrs: { type?: string | null; name?: string | null; href?: string | null };
}

export interface Observation {
  readonly url: string;
  readonly title: string;
  readonly scroll: { y: number; h: number; vh: number };
  readonly elements: readonly SerializedElement[];
}

/** An action the engine can execute against a serialized element (§3.5.6). */
export type EngineAction =
  | { readonly type: "click"; readonly idx: number }
  | { readonly type: "type"; readonly idx: number; readonly value: string }
  | { readonly type: "select"; readonly idx: number; readonly value: string }
  | { readonly type: "scroll"; readonly dy: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "extract"; readonly data: unknown }
  | { readonly type: "needs_human"; readonly kind: "otp" | "payment"; readonly prompt: string }
  | { readonly type: "done" }
  | { readonly type: "fail"; readonly reason: string };

export interface ActionResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** A read of the current cart, used by the Verifier (§3.3, Epic 6). */
export interface CartLine {
  readonly skuId: string;
  readonly title: string;
  readonly qty: number;
  readonly unitPricePaise: number;
}

export interface CartSnapshot {
  readonly platform: PlatformId;
  readonly lines: readonly CartLine[];
  readonly subtotalPaise: number;
}

export type CheckoutOutcome =
  | { readonly kind: "needs_otp"; readonly prompt: string }
  | { readonly kind: "needs_payment"; readonly amountPaise: number; readonly prompt: string }
  | { readonly kind: "credit_ok"; readonly amountPaise: number };

export interface PlaceOrderResult {
  readonly orderRef: string;
  readonly totalPaise: number;
  readonly paidOnCredit: boolean;
}

/**
 * The typed, in-process API the device speaks instead of the raw bridge (§3.6.2, §3.6.7).
 * Every method internally runs the §3.5 perceive→act loop.
 */
export interface AutomationEngine {
  readonly platform: PlatformId;

  /** Open the platform webview (hidden by default) and wait until it has settled. */
  open(url: string, opts?: { hidden?: boolean }): Promise<void>;
  close(): Promise<void>;

  /** Reveal the live webview for a HITL moment (OTP/payment); §3.5.9. */
  show(): Promise<void>;
  hide(): Promise<void>;

  /** Drive search for one requested item. */
  search(item: RequestedItem): Promise<void>;
  /** Read the best-matching product into a Quote (playbook first, Claude fallback). */
  readProduct(item: RequestedItem): Promise<Quote>;
  /** Add a SKU/qty to the cart. */
  addToCart(skuId: string, qty: number): Promise<void>;
  /** Read the current cart for verification. */
  getCart(): Promise<CartSnapshot>;
  /** Begin checkout; resolves to whether OTP/payment is needed or credit is OK. */
  checkout(): Promise<CheckoutOutcome>;
  /** Place the order (only after Verifier passes and credit is OK or payment done). */
  placeOrder(idempotencyKey: string): Promise<PlaceOrderResult>;

  /** Subscribe to domain events; returns an unsubscribe function. */
  on(listener: DomainEventListener): () => void;

  /**
   * Best-effort check of whether the currently open page is a login wall (so the caller can prompt for
   * sign-in only when needed, instead of always). Optional: implemented by the WebView engine; mocks
   * may omit it.
   */
  detectLoginWall?(): Promise<boolean>;
}

export type { DomainEvent };

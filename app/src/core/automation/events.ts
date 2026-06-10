/**
 * Typed domain events emitted upward by an AutomationEngine / adapter (PROCURE_COPILOT_PLAN.md
 * §3.6.3). The orchestrator translates lifecycle/HITL bridge signals into these, never raw DOM.
 */
import type { PlatformId, Quote } from "../domain/types";

export interface QuoteRead {
  readonly type: "QuoteRead";
  readonly platform: PlatformId;
  readonly quote: Quote;
}

export interface ItemAddedToCart {
  readonly type: "ItemAddedToCart";
  readonly platform: PlatformId;
  readonly skuId: string;
  readonly qty: number;
  /** Cart line count after the add, used by verifyStepEffect. */
  readonly cartCount: number;
}

export interface NeedsOtp {
  readonly type: "NeedsOtp";
  readonly platform: PlatformId;
  readonly prompt: string;
}

export interface NeedsPayment {
  readonly type: "NeedsPayment";
  readonly platform: PlatformId;
  readonly amountPaise: number;
  readonly prompt: string;
}

export interface OrderPlaced {
  readonly type: "OrderPlaced";
  readonly platform: PlatformId;
  readonly orderRef: string;
  readonly totalPaise: number;
  readonly paidOnCredit: boolean;
}

export interface StepFailed {
  readonly type: "StepFailed";
  readonly platform: PlatformId;
  readonly step: string;
  readonly reason: string;
  /** Reference to a screenshot captured on failure, for eval (§3.5.10). */
  readonly screenshotRef?: string;
}

export type DomainEvent =
  | QuoteRead
  | ItemAddedToCart
  | NeedsOtp
  | NeedsPayment
  | OrderPlaced
  | StepFailed;

export type DomainEventType = DomainEvent["type"];

export type DomainEventListener = (event: DomainEvent) => void;

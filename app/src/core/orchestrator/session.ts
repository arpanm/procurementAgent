/**
 * The `ProcurementSession` state machine (PROCURE_COPILOT_PLAN.md §3.6.4) — event-sourced and
 * resumable. The orchestrator is the SINGLE WRITER: it never mutates {@link SessionState} directly,
 * it only emits {@link SessionEvent}s through the pure reducer {@link apply}. Because every state
 * change is an immutable, replayable event, a cold-started app can rebuild the exact live state from
 * the persisted log with {@link hydrate} (§3.6.5), then continue.
 *
 * Safety invariant (Epic 5 acceptance, §2): nothing irreversible may proceed without an explicit
 * approval. The reducer encodes this — `executing`/`needs_otp`/`needs_payment`/`placing`/`done`
 * states are ONLY reachable once an {@link Approved} event has set `approved: true`. Automation
 * events (`NeedsOtp`, `OrderPlaced`, …) received before approval are ignored, never acted on.
 */
import type {
  Allocation,
  OrderStatus,
  PlatformId,
  ProcurementRequest,
  Quote,
  RequestedItem,
} from "../domain/types";
import type { DomainEvent } from "../automation/events";

/** The full lifecycle of a procurement session. */
export type SessionStatus =
  | "idle"
  | "planning"
  | "quoting"
  | "optimizing"
  | "awaiting_approval"
  | "modifying"
  | "approved"
  | "executing"
  | "needs_otp"
  | "needs_payment"
  | "placing"
  | "done"
  | "failed"
  | "cancelled";

/** Terminal states from which no further transitions are meaningful. */
const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  "done",
  "failed",
  "cancelled",
]);

/** A lightweight per-platform order-attempt placeholder (full {@link OrderAttempt} lands in Epic 6). */
export interface OrderAttemptState {
  readonly platform: PlatformId;
  readonly status: OrderStatus;
  readonly orderRef?: string;
  readonly totalPaise?: number;
  readonly paidOnCredit?: boolean;
}

/** A retailer edit at the approval gate (§3.3 HITL, Epic 5 modify flow). */
export type ModifyChange =
  | { readonly kind: "change-qty"; readonly itemName: string; readonly qty: number }
  | { readonly kind: "drop-item"; readonly itemName: string }
  | {
      readonly kind: "swap-platform";
      readonly canonicalItemId: string;
      readonly itemName: string;
      readonly platform: PlatformId;
    };

/** The complete, serialisable session state held in the observable store. */
export interface SessionState {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly request: ProcurementRequest | null;
  /** Current (possibly modified) demand the optimizer runs against. */
  readonly items: readonly RequestedItem[];
  /** Quotes collected so far, deduped by platform+SKU. */
  readonly quotes: readonly Quote[];
  /** Latest optimizer result, or null before the first optimize. */
  readonly allocation: Allocation | null;
  /** Pinned platform per canonical item from a swap-platform edit (forces the next optimize). */
  readonly pins: Readonly<Record<string, PlatformId>>;
  /** True only after an explicit {@link Approved} event — the irreversible-action gate. */
  readonly approved: boolean;
  readonly orderAttempts: readonly OrderAttemptState[];
  readonly error: string | null;
  /** Monotonic count of events applied — useful for optimistic checks and debugging. */
  readonly version: number;
}

/**
 * The orchestrator's own event union, plus the automation-layer {@link DomainEvent}s it folds in.
 * The two never collide (distinct `type` string literals).
 */
export type OrchestratorEvent =
  | { readonly type: "SessionStarted"; readonly request: ProcurementRequest }
  | { readonly type: "PlanReady"; readonly items: readonly RequestedItem[] }
  | { readonly type: "QuoteCollected"; readonly quote: Quote }
  | { readonly type: "OptimizeStarted" }
  | { readonly type: "Optimized"; readonly allocation: Allocation }
  | { readonly type: "ApprovalRequested" }
  | { readonly type: "Approved" }
  | { readonly type: "ModifyRequested"; readonly change: ModifyChange }
  | { readonly type: "Cancelled" };

export type SessionEvent = OrchestratorEvent | DomainEvent;

/** The empty starting state for a fresh (or about-to-hydrate) session. */
export function initialState(sessionId: string): SessionState {
  return {
    sessionId,
    status: "idle",
    request: null,
    items: [],
    quotes: [],
    allocation: null,
    pins: {},
    approved: false,
    orderAttempts: [],
    error: null,
    version: 0,
  };
}

/** Upsert a quote keyed by platform+SKU so re-reads replace rather than duplicate. */
function upsertQuote(quotes: readonly Quote[], quote: Quote): readonly Quote[] {
  const index = quotes.findIndex(
    (q) => q.platform === quote.platform && q.skuId === quote.skuId,
  );
  if (index === -1) {
    return [...quotes, quote];
  }
  const next = [...quotes];
  next[index] = quote;
  return next;
}

/** Apply a modify edit to the working demand + pins. Pure. */
function applyModify(
  state: SessionState,
  change: ModifyChange,
): Pick<SessionState, "items" | "pins"> {
  switch (change.kind) {
    case "change-qty": {
      const qty = Math.max(0, Math.round(change.qty));
      const items = state.items.map((item) =>
        item.name === change.itemName ? { ...item, qty } : item,
      );
      return { items, pins: state.pins };
    }
    case "drop-item": {
      const items = state.items.filter((item) => item.name !== change.itemName);
      return { items, pins: state.pins };
    }
    case "swap-platform": {
      return {
        items: state.items,
        pins: { ...state.pins, [change.canonicalItemId]: change.platform },
      };
    }
  }
}

/** Set/merge a per-platform order attempt. */
function upsertAttempt(
  attempts: readonly OrderAttemptState[],
  platform: PlatformId,
  patch: Omit<OrderAttemptState, "platform">,
): readonly OrderAttemptState[] {
  const index = attempts.findIndex((a) => a.platform === platform);
  const merged: OrderAttemptState = { platform, ...patch };
  if (index === -1) {
    return [...attempts, merged];
  }
  const next = [...attempts];
  next[index] = { ...next[index], ...merged };
  return next;
}

/** Have all platforms named in the allocation been placed? Used to decide `done`. */
function allPlatformsPlaced(state: SessionState): boolean {
  const platforms = state.allocation?.perPlatform.map((p) => p.platform) ?? [];
  if (platforms.length === 0) {
    return false;
  }
  return platforms.every((platform) =>
    state.orderAttempts.some((a) => a.platform === platform && a.status === "placed"),
  );
}

/**
 * The pure reducer. Returns the SAME reference for ignored/no-op events so the store can skip
 * notifying subscribers. Every accepted event bumps `version`.
 */
export function apply(state: SessionState, event: SessionEvent): SessionState {
  const next = reduce(state, event);
  if (Object.is(next, state)) {
    return state;
  }
  return { ...next, version: state.version + 1 };
}

function reduce(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "SessionStarted":
      return {
        ...initialState(state.sessionId),
        status: "planning",
        request: event.request,
        items: event.request.items,
      };

    case "PlanReady":
      if (TERMINAL.has(state.status)) {
        return state;
      }
      return { ...state, status: "quoting", items: event.items };

    // A quote can arrive while quoting, mid-modify, or even after an optimize (a late read).
    case "QuoteCollected":
    case "QuoteRead":
      return { ...state, quotes: upsertQuote(state.quotes, event.quote) };

    case "OptimizeStarted":
      if (TERMINAL.has(state.status) || state.status === "idle") {
        return state;
      }
      return { ...state, status: "optimizing" };

    case "Optimized":
      if (state.status !== "optimizing") {
        return state;
      }
      return { ...state, allocation: event.allocation };

    case "ApprovalRequested":
      if (state.status !== "optimizing") {
        return state;
      }
      return { ...state, status: "awaiting_approval", approved: false };

    // The single gate to irreversibility. Only the explicit approval reaches `approved`.
    case "Approved":
      if (state.status !== "awaiting_approval") {
        return state;
      }
      return { ...state, status: "approved", approved: true };

    case "ModifyRequested": {
      // Modify is only valid before approval; it re-opens the demand for re-optimization.
      if (state.status !== "awaiting_approval" && state.status !== "optimizing") {
        return state;
      }
      const { items, pins } = applyModify(state, event.change);
      return { ...state, status: "modifying", items, pins, approved: false };
    }

    case "Cancelled":
      if (TERMINAL.has(state.status)) {
        return state;
      }
      return { ...state, status: "cancelled" };

    // ----- Automation domain events (only meaningful AFTER approval) -----
    case "ItemAddedToCart":
      if (!state.approved || TERMINAL.has(state.status)) {
        return state;
      }
      return { ...state, status: "executing" };

    case "NeedsOtp":
      if (!state.approved || TERMINAL.has(state.status)) {
        return state;
      }
      return {
        ...state,
        status: "needs_otp",
        orderAttempts: upsertAttempt(state.orderAttempts, event.platform, {
          status: "needs_otp",
        }),
      };

    case "NeedsPayment":
      if (!state.approved || TERMINAL.has(state.status)) {
        return state;
      }
      return {
        ...state,
        status: "needs_payment",
        orderAttempts: upsertAttempt(state.orderAttempts, event.platform, {
          status: "needs_payment",
          totalPaise: event.amountPaise,
        }),
      };

    case "OrderPlaced": {
      if (!state.approved || TERMINAL.has(state.status)) {
        return state;
      }
      const withAttempt: SessionState = {
        ...state,
        orderAttempts: upsertAttempt(state.orderAttempts, event.platform, {
          status: "placed",
          orderRef: event.orderRef,
          totalPaise: event.totalPaise,
          paidOnCredit: event.paidOnCredit,
        }),
      };
      return {
        ...withAttempt,
        status: allPlatformsPlaced(withAttempt) ? "done" : "placing",
      };
    }

    case "StepFailed":
      if (TERMINAL.has(state.status)) {
        return state;
      }
      return {
        ...state,
        status: "failed",
        error: event.reason,
        orderAttempts: upsertAttempt(state.orderAttempts, event.platform, {
          status: "failed",
        }),
      };

    default: {
      // Exhaustiveness guard: any unhandled event type is a compile error here.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * Rebuild live state from a persisted event log (cold-start resume, §3.6.5). Replaying the ordered
 * log through the same reducer yields exactly the state the device had when the events were emitted.
 */
export function hydrate(
  sessionId: string,
  events: readonly SessionEvent[],
): SessionState {
  return events.reduce(apply, initialState(sessionId));
}

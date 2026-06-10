/**
 * The on-device orchestrator (PROCURE_COPILOT_PLAN.md §3.3, §3.6.4). It is the SINGLE WRITER of the
 * {@link SessionState}: it emits {@link SessionEvent}s through the pure reducer and, on every change,
 * does the two things §3.6.4 mandates, in order:
 *
 *   1. Update the local observable store → the UX re-renders instantly (zero network).
 *   2. Append the event to the backend as the durable record — fire-and-forget through a local
 *      OUTBOX with retry, so a connectivity blip never blocks the live UX.
 *
 * HITL safety (§3.3, Epic 5): nothing irreversible runs without an explicit {@link approve}. The
 * reducer enforces that `approved`/`executing`/… are unreachable without an `Approved` event, and
 * {@link modify}/{@link cancel} never place an order — they only reshape demand or stop the session.
 */
import type { BackendClient } from "../backend/BackendClient";
import type { Allocation, ProcurementRequest, Quote } from "../domain/types";
import type { DomainEvent } from "../automation/events";
import { OptimizerClient, type PlatformConstraint } from "../optimizer/OptimizerClient";
import { createStore, type ReadableStore, type Store } from "./store";
import {
  apply,
  initialState,
  type ModifyChange,
  type SessionEvent,
  type SessionState,
} from "./session";

export interface OrchestratorOptions {
  /** Inject a store (e.g. shared with other surfaces); defaults to a fresh one. */
  readonly store?: Store<SessionState>;
  /** Inject the optimizer client (e.g. to spy on it); defaults to one wrapping `backend`. */
  readonly optimizer?: OptimizerClient;
  /** Pre-known session id; if absent, {@link start} creates one via `backend.createSession`. */
  readonly sessionId?: string;
  /** Explicit optimizer constraints; otherwise derived from the collected quotes. */
  readonly constraints?: readonly PlatformConstraint[];
  /** Max retry attempts per outbox event before giving up (so a dead backend can't wedge it). */
  readonly maxRetries?: number;
  /** Base backoff between outbox retries, in ms (multiplied by attempt#). 0 in tests. */
  readonly retryDelayMs?: number;
}

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class Orchestrator implements ReadableStore<SessionState> {
  private readonly store: Store<SessionState>;
  private readonly optimizer: OptimizerClient;
  private readonly constraints?: readonly PlatformConstraint[];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  private sessionId: string;

  /** FIFO outbox of events awaiting durable append; order is preserved (the log is ordered). */
  private readonly outbox: SessionEvent[] = [];
  /** Serialises drains so events append in order and we never run two drains at once. */
  private flushTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: BackendClient,
    options: OrchestratorOptions = {},
  ) {
    this.sessionId = options.sessionId ?? "";
    this.store = options.store ?? createStore(initialState(this.sessionId));
    this.optimizer = options.optimizer ?? new OptimizerClient(backend);
    this.constraints = options.constraints;
    this.maxRetries = options.maxRetries ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  // ----- Read access (for useSyncExternalStore) -----

  getState = (): SessionState => this.store.getState();

  subscribe = (listener: () => void): (() => void) =>
    this.store.subscribe(listener);

  // ----- Lifecycle commands (the single writer) -----

  /** Begin a session: ensure a durable session id, then record start + plan. */
  async start(request: ProcurementRequest): Promise<void> {
    if (this.sessionId === "") {
      try {
        const session = await this.backend.createSession(request);
        this.sessionId = session.id;
      } catch {
        // Offline / backend down: fall back to the request id and proceed local-first.
        this.sessionId = request.id;
      }
    }
    // Establish identity in the store before the first event (internal, not an appended event).
    this.store.setState(() => initialState(this.sessionId));

    this.dispatch({ type: "SessionStarted", request });

    let items = request.items;
    try {
      const plan = await this.backend.plan({
        requestText: request.items.map((i) => i.raw).join("; "),
        items: request.items,
      });
      if (plan.normalizedItems.length > 0) {
        items = plan.normalizedItems;
      }
    } catch {
      // Graceful: planning is best-effort; the raw requested items are a valid demand.
    }
    this.dispatch({ type: "PlanReady", items });
  }

  /** Record a quote read off a platform (Epic 2/3 feed this). */
  recordQuote(quote: Quote): void {
    this.dispatch({ type: "QuoteCollected", quote });
  }

  /**
   * Run the optimizer against the current demand + quotes and surface the result for approval.
   * Idempotent and resumable: it only reads state and emits events; calling it again re-solves.
   */
  async optimize(): Promise<Allocation> {
    this.dispatch({ type: "OptimizeStarted" });
    const { items, quotes, pins } = this.store.getState();
    const allocation = await this.optimizer.optimize(items, quotes, {
      pins,
      constraints: this.constraints,
    });
    this.dispatch({ type: "Optimized", allocation });
    this.dispatch({ type: "ApprovalRequested" });
    return allocation;
  }

  /** The HITL approval gate — the ONLY path to irreversible execution. */
  approve(): void {
    this.dispatch({ type: "Approved" });
  }

  /**
   * Apply a retailer edit (swap platform / change qty / drop item) to the demand and RE-OPTIMIZE.
   * Never places an order. Idempotent + resumable: it reshapes demand then re-runs {@link optimize}.
   */
  async modify(change: ModifyChange): Promise<Allocation> {
    this.dispatch({ type: "ModifyRequested", change });
    return this.optimize();
  }

  /** Cancel the session. Never places an order. */
  cancel(): void {
    this.dispatch({ type: "Cancelled" });
  }

  /** Fold an automation-layer domain event (OTP/payment/placed/failed) into the session. */
  ingest(event: DomainEvent): void {
    this.dispatch(event);
  }

  /** Await the outbox draining to empty — primarily for tests / graceful shutdown. */
  async flush(): Promise<void> {
    await this.flushTail;
  }

  // ----- Internals -----

  /**
   * The single write primitive: (1) update local store, (2) enqueue for durable append. The order
   * matters — the UX must reflect state before we attempt the (possibly slow/failing) network call.
   */
  private dispatch(event: SessionEvent): void {
    const before = this.store.getState();
    this.store.setState((s) => apply(s, event));
    // Only persist events the reducer actually accepted (ignored no-ops aren't part of the log).
    if (!Object.is(this.store.getState(), before)) {
      this.enqueueOutbox(event);
    }
  }

  private enqueueOutbox(event: SessionEvent): void {
    this.outbox.push(event);
    this.flushTail = this.flushTail.then(() => this.drain());
  }

  /** Drain the outbox head-first with bounded retry+backoff; head-of-line ordering preserved. */
  private async drain(): Promise<void> {
    while (this.outbox.length > 0) {
      const event = this.outbox[0];
      let attempt = 0;
      for (;;) {
        try {
          await this.backend.appendEvent(this.sessionId, event);
          this.outbox.shift();
          break;
        } catch {
          attempt += 1;
          if (attempt > this.maxRetries) {
            // Give up on this event so it can't wedge the queue; the local store stays correct.
            this.outbox.shift();
            break;
          }
          await delay(this.retryDelayMs * attempt);
        }
      }
    }
  }
}

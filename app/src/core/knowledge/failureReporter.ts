/**
 * Device-side FAILURE REPORTER for the guided-RAG eval pipeline.
 *
 * When an agent step fails on a real platform (e.g. add-to-cart not confirmed), we ship a compact
 * failure record to the backend `/eval/{platform}/failures` endpoint so the eval flow can later mine
 * recurring failures and propose knowledge-doc patches. To avoid spamming the backend (and the LLM eval
 * it can trigger), reporting is RATE-LIMITED to at most once per hour per `platform|flow|signature` —
 * the same repeating failure within the window is dropped on-device. The cooldown is persisted (so it
 * survives app relaunches) and the backend enforces its own ≤1/hr cooldown as the real guarantee.
 *
 * Every method is best-effort and NEVER throws: a flaky/absent backend can only mean a lost report,
 * never a crashed agent run.
 */
import type { PlatformId } from "../domain/types";
import type { KnowledgeTransport } from "./PlatformKnowledgeStore";
import type { StorageLike } from "./siteMemory";

/** A single observed failure, shipped to the backend eval ingest endpoint. */
export interface FailureReport {
  /** Which agent flow failed, e.g. "addToCart", "readQuote", "search". */
  readonly flow: string;
  /**
   * A stable grouping key for this *kind* of failure (used for dedupe + server-side cooldown). Pick
   * something that repeats for the same root cause — e.g. the skuId or a normalized reason — NOT a value
   * that changes every run (timestamps/random ids), or the cooldown never engages.
   */
  readonly signature: string;
  /** Human/agent-readable reason the step failed. */
  readonly reason: string;
  readonly url?: string;
  /** Compact DOM summary (never the full DOM) — what the page showed when it failed. */
  readonly domDigest?: string;
  /** Raw base64 PNG of the page at failure (no `data:` prefix), for the vision eval. */
  readonly screenshotBase64?: string;
  readonly skuId?: string;
  readonly itemName?: string;
}

export interface FailureReporter {
  /** Best-effort: ship a failure unless it's within the per-signature cooldown. Never throws. */
  report(platform: PlatformId, report: FailureReport): Promise<void>;
}

const KEY = "pc.failcooldown";
/** At most one report per `platform|flow|signature` within this window. */
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Posts failures to `/eval/{platform}/failures` via the shared {@link KnowledgeTransport}, rate-limited
 * to ≤1/hr per `platform|flow|signature`. The cooldown map is persisted through {@link StorageLike}
 * (localStorage on device) so a tight failure loop across relaunches still can't flood the backend.
 */
export class BackendFailureReporter implements FailureReporter {
  private readonly transport: KnowledgeTransport;
  private readonly storage?: StorageLike;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private lastSent: Map<string, number>;

  constructor(
    transport: KnowledgeTransport,
    opts?: { storage?: StorageLike; cooldownMs?: number; now?: () => number },
  ) {
    this.transport = transport;
    this.storage = opts?.storage ?? defaultStorage();
    this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts?.now ?? (() => Date.now());
    this.lastSent = this.load();
  }

  async report(platform: PlatformId, report: FailureReport): Promise<void> {
    const key = `${platform}|${report.flow}|${report.signature}`;
    const now = this.now();
    const last = this.lastSent.get(key);
    if (last != null && now - last < this.cooldownMs) return; // within cooldown → drop

    // Reserve the slot BEFORE awaiting the post, so two near-simultaneous failures of the same kind
    // can't both slip through while the first request is in flight.
    const previous = this.lastSent.get(key);
    this.lastSent.set(key, now);
    this.persist();

    try {
      await this.transport.post(`/eval/${platform}/failures`, {
        ...report,
        at: new Date(now).toISOString(),
      });
    } catch {
      // The post FAILED (transient backend blip). Roll the cooldown back to its prior value so a genuine
      // recurring failure isn't silently suppressed for the full hour on the strength of a lost request —
      // the next occurrence gets another attempt. (The in-flight double is still prevented above.)
      if (previous == null) {
        this.lastSent.delete(key);
      } else {
        this.lastSent.set(key, previous);
      }
      this.persist();
    }
  }

  private load(): Map<string, number> {
    const map = new Map<string, number>();
    if (!this.storage) return map;
    try {
      const raw = this.storage.getItem(KEY);
      if (!raw) return map;
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "number") map.set(k, v);
      }
    } catch {
      /* corrupt/absent → empty */
    }
    return map;
  }

  private persist(): void {
    if (!this.storage) return;
    // Prune entries older than the cooldown window so the blob can't grow unbounded.
    const cutoff = this.now() - this.cooldownMs;
    for (const [k, v] of this.lastSent) {
      if (v < cutoff) this.lastSent.delete(k);
    }
    try {
      this.storage.setItem(KEY, JSON.stringify(Object.fromEntries(this.lastSent)));
    } catch {
      /* private mode / quota → in-memory only */
    }
  }
}

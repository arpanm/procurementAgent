/**
 * Learned, persistent SITE MEMORY (per-platform agents + RAG plan).
 *
 * This is the on-device "guided RAG" the user asked for: instead of re-discovering a platform's layout
 * from scratch every run (search box, product cards, ADD button, product-detail URLs), the agent LEARNS
 * durable facts from each SUCCESSFUL interaction and REUSES them next time before falling back to
 * heuristics or a vision/Claude call. Two kinds of memory are kept per platform:
 *
 *  - productUrls: the detail-page URL we actually reached for a canonical item (keyed by canonicalItemId),
 *    so checkout/quote can open the exact product directly instead of re-searching.
 *  - locators: durable {@link ElementSignature}s for named page roles ("search:searchBox",
 *    "listing:productCard", "detail:addToCart"), so finders can replay a known-good control.
 *
 * Storage is `localStorage` (persists across launches inside the Capacitor WebView), mirroring
 * {@link ../auth/loginStore}. It holds only public layout facts — never credentials/cookies. Every method
 * is best-effort and NEVER throws (private mode / SSR just degrades to no memory), so site memory can
 * only ever speed the agent up, never block it.
 */
import type { PlatformId } from "../domain/types";
import type { SerializedElement } from "../automation/AutomationEngine";
import {
  type ElementSignature,
  sameSignature,
  toSignature,
} from "./signature";

/** A learned product-detail URL for a canonical item. */
export interface RememberedUrl {
  readonly url: string;
  readonly title: string;
  readonly at: string;
  readonly hits: number;
}

/** The full persisted shape for one platform. */
export interface SiteMemoryData {
  readonly productUrls: Record<string, RememberedUrl>;
  readonly locators: Record<string, ElementSignature[]>;
}

/** Minimal storage surface (localStorage satisfies it); injectable for tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = "pc.sitemem.";
/** Keep at most this many competing signatures per locator role. */
const MAX_SIGS_PER_KEY = 5;
/** Drop a signature once a miss decays it below this floor. */
const CONFIDENCE_FLOOR = 0.2;

function emptyData(): SiteMemoryData {
  return { productUrls: {}, locators: {} };
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export class SiteMemory {
  private readonly storage?: StorageLike;
  private readonly key: string;
  private readonly now: () => string;
  private data: SiteMemoryData;

  constructor(
    platform: PlatformId,
    opts: { storage?: StorageLike; now?: () => string } = {},
  ) {
    this.storage = opts.storage ?? defaultStorage();
    this.now = opts.now ?? (() => new Date().toISOString());
    this.key = `${KEY_PREFIX}${platform}`;
    this.data = this.load();
  }

  // ----- product URLs --------------------------------------------------------

  /** The learned detail-page URL for an item, if confident enough to reuse. */
  recallProductUrl(canonicalItemId: string): RememberedUrl | undefined {
    return this.data.productUrls[canonicalItemId];
  }

  /** Record (or reinforce) the detail URL we reached for an item. Idempotent per (item,url). */
  rememberProductUrl(canonicalItemId: string, url: string, title: string): void {
    if (!canonicalItemId || !url) return;
    const prev = this.data.productUrls[canonicalItemId];
    const hits = prev && prev.url === url ? prev.hits + 1 : 1;
    this.data = {
      ...this.data,
      productUrls: {
        ...this.data.productUrls,
        [canonicalItemId]: { url, title, at: this.now(), hits },
      },
    };
    this.persist();
  }

  // ----- element locators ----------------------------------------------------

  /** All learned signatures for a role, best (highest confidence) first. */
  recallLocators(key: string): readonly ElementSignature[] {
    return [...(this.data.locators[key] ?? [])].sort((a, b) => b.confidence - a.confidence);
  }

  /** The single best learned signature for a role, or undefined when none is confident. */
  recallLocator(key: string): ElementSignature | undefined {
    return this.recallLocators(key)[0];
  }

  /**
   * Learn (or REINFORCE) the signature of a successfully-used element for a role. A matching existing
   * signature (same tag+name) is reinforced (confidence↑, hits↑, geometry refreshed); otherwise it's
   * added (capped, lowest-confidence evicted). Pass a {@link SerializedElement} or a ready signature.
   */
  rememberLocator(key: string, elOrSig: SerializedElement | ElementSignature): void {
    const fresh = isSignature(elOrSig) ? elOrSig : toSignature(elOrSig, { at: this.now() });
    const list = [...(this.data.locators[key] ?? [])];
    const idx = list.findIndex((s) => sameSignature(s, fresh));
    if (idx >= 0) {
      const prev = list[idx];
      list[idx] = {
        ...prev,
        cx: fresh.cx,
        cy: fresh.cy,
        confidence: Math.min(1, prev.confidence + 0.15 * (1 - prev.confidence) + 0.05),
        hits: prev.hits + 1,
        lastSuccessAt: this.now(),
      };
    } else {
      list.push({ ...fresh, lastSuccessAt: this.now() });
    }
    // Keep only the strongest signatures for the role.
    list.sort((a, b) => b.confidence - a.confidence || b.hits - a.hits);
    this.data = {
      ...this.data,
      locators: { ...this.data.locators, [key]: list.slice(0, MAX_SIGS_PER_KEY) },
    };
    this.persist();
  }

  /**
   * Decay a learned signature after it FAILED to locate its element this run, so a stale locator stops
   * being tried. Drops it entirely once confidence falls below the floor.
   */
  penalizeLocator(key: string, sig: ElementSignature): void {
    const list = this.data.locators[key];
    if (!list) return;
    const next = list
      .map((s) =>
        sameSignature(s, sig) ? { ...s, confidence: s.confidence - 0.34 } : s,
      )
      .filter((s) => s.confidence >= CONFIDENCE_FLOOR);
    this.data = { ...this.data, locators: { ...this.data.locators, [key]: next } };
    this.persist();
  }

  /** The raw persisted snapshot (for diagnostics/tests). */
  snapshot(): SiteMemoryData {
    return this.data;
  }

  // ----- persistence ---------------------------------------------------------

  private load(): SiteMemoryData {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return emptyData();
      const parsed = JSON.parse(raw) as Partial<SiteMemoryData>;
      return {
        productUrls: parsed.productUrls ?? {},
        locators: parsed.locators ?? {},
      };
    } catch {
      return emptyData();
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* storage unavailable (private mode / SSR) — memory is best-effort only */
    }
  }
}

function isSignature(x: SerializedElement | ElementSignature): x is ElementSignature {
  return (x as ElementSignature).namePattern !== undefined;
}

/**
 * Typed client for the Spring Boot backend (PROCURE_COPILOT_PLAN.md §3.6.7). The device speaks this
 * instead of HTTP directly, so transport can be mocked in tests. The backend is a stateless
 * reasoning provider (`/plan`, `/next-action`, `/verify`, `/intent`, `/optimize`) plus a durable
 * event store (`/sessions...`).
 */
import type {
  Allocation,
  PlatformId,
  Quote,
  RequestedItem,
} from "../domain/types";
import type { EngineAction, Observation } from "../automation/AutomationEngine";

export interface PlanRequest {
  readonly requestText: string;
  readonly items: readonly RequestedItem[];
}

export interface PlanResponse {
  readonly normalizedItems: readonly RequestedItem[];
  readonly platforms: readonly PlatformId[];
}

export interface NextActionRequest {
  readonly platform: PlatformId;
  readonly task: string;
  readonly observation: Observation;
  readonly history: readonly EngineAction[];
}

export interface VerifyRequest {
  readonly platform: PlatformId;
  readonly expected: { skuId: string; qty: number; unitPricePaise: number }[];
  readonly actual: { skuId: string; qty: number; unitPricePaise: number }[];
}

export interface VerifyResponse {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

export interface IntentRequest {
  readonly text: string;
  readonly locale?: string;
}

export interface IntentResponse {
  readonly items: readonly RequestedItem[];
  readonly confidence: number;
}

export interface OptimizeRequest {
  readonly items: readonly RequestedItem[];
  readonly quotes: readonly Quote[];
  readonly constraints: readonly {
    platform: PlatformId;
    movPaise: number;
    deliveryFeePaise: number;
    creditAvailablePaise?: number;
  }[];
}

export interface BackendClient {
  intent(req: IntentRequest): Promise<IntentResponse>;
  plan(req: PlanRequest): Promise<PlanResponse>;
  nextAction(req: NextActionRequest): Promise<EngineAction>;
  verify(req: VerifyRequest): Promise<VerifyResponse>;
  optimize(req: OptimizeRequest): Promise<Allocation>;
  appendEvent(sessionId: string, event: unknown): Promise<void>;
  createSession(req: unknown): Promise<{ id: string }>;
  getSession(sessionId: string): Promise<unknown>;
}

/** Minimal fetch transport used by the HTTP implementation; mockable in tests. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Reachability probe for a base URL; returns true if the host answers. Mockable in tests. */
export type ProbeLike = (baseUrl: string) => Promise<boolean>;

/**
 * Default reachability probe: a `no-cors` GET to `/actuator/health`. `no-cors` means we don't need CORS
 * headers on the health endpoint — the request resolves (opaque) when the host is reachable and rejects
 * when it isn't, which is exactly the signal we want. Aborts after a short timeout so a dead candidate
 * doesn't stall resolution.
 */
const defaultProbe: ProbeLike = async (baseUrl) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${baseUrl}/actuator/health`, {
        mode: "no-cors",
        signal: controller.signal,
      } as RequestInit);
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};

export class HttpBackendClient implements BackendClient {
  /** Candidate base URLs in preference order; the reachable one is resolved lazily and cached. */
  private readonly candidates: string[];
  private resolved?: string;
  private resolving?: Promise<string>;

  constructor(
    baseUrl: string | readonly string[],
    // Default to a wrapper rather than a bare `fetch` reference: the browser's native `fetch`
    // must be invoked with `this === window`, so calling it as `this.fetchImpl(...)` on a bare
    // reference throws "Failed to execute 'fetch' on 'Window': Illegal invocation". Wrapping it
    // calls `fetch` unqualified, which keeps the correct binding. Tests inject their own mock.
    private readonly fetchImpl: FetchLike = (input, init) =>
      fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>,
    private readonly probeImpl: ProbeLike = defaultProbe,
  ) {
    const list = (typeof baseUrl === "string" ? [baseUrl] : [...baseUrl])
      .map((u) => u.replace(/\/+$/, ""))
      .filter((u, i, a) => Boolean(u) && a.indexOf(u) === i);
    this.candidates = list.length ? list : ["http://localhost:8080"];
    // A single candidate (the common test path) needs no probing — behave exactly as before.
    if (this.candidates.length === 1) this.resolved = this.candidates[0];
  }

  /** Pick the first reachable candidate (probing in parallel); fall back to the first if none answer. */
  private async resolveBase(): Promise<string> {
    if (this.resolved) return this.resolved;
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      const results = await Promise.all(
        this.candidates.map(async (c) => ({ c, ok: await this.probeImpl(c).catch(() => false) })),
      );
      const hit = results.find((r) => r.ok);
      const chosen = hit ? hit.c : this.candidates[0];
      this.resolved = chosen;
      this.resolving = undefined;
      return chosen;
    })();
    return this.resolving;
  }

  /** Drop the cached choice on a transport failure so the next call re-probes (e.g. tunnel dropped). */
  private onTransportError(): void {
    if (this.candidates.length > 1) this.resolved = undefined;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const base = await this.resolveBase();
    let res;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.onTransportError();
      throw err;
    }
    if (!res.ok) {
      throw new Error(`Backend ${path} failed with status ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const base = await this.resolveBase();
    let res;
    try {
      res = await this.fetchImpl(`${base}${path}`);
    } catch (err) {
      this.onTransportError();
      throw err;
    }
    if (!res.ok) {
      throw new Error(`Backend ${path} failed with status ${res.status}`);
    }
    return (await res.json()) as T;
  }

  intent(req: IntentRequest): Promise<IntentResponse> {
    return this.post<IntentResponse>("/intent", req);
  }

  plan(req: PlanRequest): Promise<PlanResponse> {
    return this.post<PlanResponse>("/plan", req);
  }

  nextAction(req: NextActionRequest): Promise<EngineAction> {
    return this.post<EngineAction>("/next-action", req);
  }

  verify(req: VerifyRequest): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", req);
  }

  optimize(req: OptimizeRequest): Promise<Allocation> {
    return this.post<Allocation>("/optimize", req);
  }

  appendEvent(sessionId: string, event: unknown): Promise<void> {
    return this.post<void>(`/sessions/${sessionId}/events`, event);
  }

  createSession(req: unknown): Promise<{ id: string }> {
    return this.post<{ id: string }>("/sessions", req);
  }

  getSession(sessionId: string): Promise<unknown> {
    return this.get<unknown>(`/sessions/${sessionId}`);
  }
}

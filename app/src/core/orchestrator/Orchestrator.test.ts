import { describe, expect, it, vi } from "vitest";
import { BackendHttpError } from "../backend/BackendClient";
import type { BackendClient, OptimizeRequest } from "../backend/BackendClient";
import type {
  Allocation,
  ProcurementRequest,
  Quote,
  RequestedItem,
} from "../domain/types";
import { Orchestrator } from "./Orchestrator";

const ITEMS: readonly RequestedItem[] = [
  { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" },
];

const REQUEST: ProcurementRequest = {
  id: "req-1",
  items: ITEMS,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function quote(): Quote {
  return {
    platform: "hyperpure",
    skuId: "hp-potato",
    canonicalItemId: "potato",
    title: "potato",
    pricePaise: 1000,
    inStock: true,
    readAt: "2026-01-01T00:00:00.000Z",
  };
}

function allocation(grandTotalPaise: number): Allocation {
  return {
    perPlatform: [
      {
        platform: "hyperpure",
        lines: [
          {
            canonicalItemId: "potato",
            itemName: "potato",
            platform: "hyperpure",
            skuId: "hp-potato",
            qty: 5,
            unitPricePaise: 1000,
            lineTotalPaise: grandTotalPaise,
            reason: "cheaper on Hyperpure",
          },
        ],
        subtotalPaise: grandTotalPaise,
        deliveryFeePaise: 0,
        totalPaise: grandTotalPaise,
        meetsMov: true,
        payableOnCredit: true,
      },
    ],
    grandTotalPaise,
    singlePlatformBaselinePaise: grandTotalPaise + 1000,
    savingPaise: -1000,
    unfulfilled: [],
  };
}

interface BackendMocks {
  readonly backend: BackendClient;
  readonly optimize: ReturnType<typeof vi.fn>;
  readonly appendEvent: ReturnType<typeof vi.fn>;
}

function makeBackend(overrides: Partial<Record<keyof BackendClient, unknown>> = {}): BackendMocks {
  const reject = () => Promise.reject(new Error("not used"));
  const optimize = vi.fn(async () => allocation(9000));
  const appendEvent = vi.fn(async () => undefined);
  const backend: BackendClient = {
    intent: reject as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: reject as unknown as BackendClient["verify"],
    optimize: optimize as unknown as BackendClient["optimize"],
    appendEvent: appendEvent as unknown as BackendClient["appendEvent"],
    createSession: (async () => ({ id: "s1" })) as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
    ...(overrides as Partial<BackendClient>),
  };
  return { backend, optimize, appendEvent };
}

describe("Orchestrator", () => {
  it("start() ends in quoting with the requested demand and persists events", async () => {
    const { backend, appendEvent } = makeBackend();
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    await orch.start(REQUEST);
    await orch.flush();

    expect(orch.getState().status).toBe("quoting");
    expect(orch.getState().items).toEqual(ITEMS);
    expect(appendEvent).toHaveBeenCalled(); // SessionStarted + PlanReady appended
  });

  it("optimize() calls the backend optimizer and lands in awaiting_approval", async () => {
    const { backend, optimize } = makeBackend();
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    await orch.start(REQUEST);
    orch.recordQuote(quote());
    const result = await orch.optimize();

    expect(optimize).toHaveBeenCalledTimes(1);
    expect(result.grandTotalPaise).toBe(9000);
    expect(orch.getState().status).toBe("awaiting_approval");
    expect(orch.getState().allocation?.grandTotalPaise).toBe(9000);
  });

  it("modify() RE-OPTIMIZES with the updated demand and updates the store", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce(allocation(9000))
      .mockResolvedValueOnce(allocation(7000));
    const { backend } = makeBackend({ optimize });
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    await orch.start(REQUEST);
    orch.recordQuote(quote());
    await orch.optimize();

    await orch.modify({ kind: "change-qty", itemName: "potato", qty: 9 });

    expect(optimize).toHaveBeenCalledTimes(2);
    const secondReq = optimize.mock.calls[1][0] as OptimizeRequest;
    expect(secondReq.items.find((i) => i.name === "potato")?.qty).toBe(9);
    expect(orch.getState().allocation?.grandTotalPaise).toBe(7000);
    expect(orch.getState().status).toBe("awaiting_approval");
  });

  it("requires explicit approve() to reach approved (gating)", async () => {
    const { backend } = makeBackend();
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    await orch.start(REQUEST);
    orch.recordQuote(quote());
    await orch.optimize();
    expect(orch.getState().approved).toBe(false);
    expect(orch.getState().status).toBe("awaiting_approval");

    orch.approve();
    expect(orch.getState().approved).toBe(true);
    expect(orch.getState().status).toBe("approved");
  });

  it("modify() and cancel() never approve or place orders", async () => {
    const { backend } = makeBackend();
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    await orch.start(REQUEST);
    orch.recordQuote(quote());
    await orch.optimize();

    await orch.modify({ kind: "change-qty", itemName: "potato", qty: 3 });
    expect(orch.getState().approved).toBe(false);

    orch.cancel();
    expect(orch.getState().status).toBe("cancelled");
    expect(orch.getState().approved).toBe(false);
  });

  it("notifies store subscribers on state changes (drives useSyncExternalStore)", async () => {
    const { backend } = makeBackend();
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });
    const listener = vi.fn();
    orch.subscribe(listener);

    await orch.start(REQUEST);

    expect(listener).toHaveBeenCalled();
  });

  it("outbox retries appendEvent on failure until it succeeds", async () => {
    const appendEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { backend } = makeBackend({ appendEvent });
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    orch.recordQuote(quote());
    await orch.flush();

    // First call rejected, retried, second resolved → exactly one event, two attempts.
    expect(appendEvent).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry the outbox on a permanent 4xx (e.g. session 404 after a backend restart)", async () => {
    const appendEvent = vi
      .fn()
      .mockRejectedValue(new BackendHttpError("/sessions/s1/events", 404));
    const { backend } = makeBackend({ appendEvent });
    const orch = new Orchestrator(backend, { sessionId: "s1", retryDelayMs: 0 });

    orch.recordQuote(quote());
    await orch.flush();

    // A 404 is permanent for an unchanged POST → dropped immediately, no retry storm.
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  it("falls back to the request id and stays local-first when createSession fails", async () => {
    const { backend } = makeBackend({
      createSession: async () => {
        throw new Error("no network");
      },
    });
    const orch = new Orchestrator(backend, { retryDelayMs: 0 });

    await orch.start(REQUEST);

    expect(orch.getState().status).toBe("quoting");
  });
});

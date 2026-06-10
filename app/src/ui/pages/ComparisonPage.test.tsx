import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendClient } from "../../core/backend/BackendClient";
import type {
  Allocation,
  ProcurementRequest,
  Quote,
  RequestedItem,
} from "../../core/domain/types";
import { Orchestrator } from "../../core/orchestrator/Orchestrator";
import { ComparisonPage } from "./ComparisonPage";

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
            reason: "cheaper on Hyperpure by Rs 38",
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
    singlePlatformBaselinePaise: grandTotalPaise + 2000,
    savingPaise: -2000,
    unfulfilled: [],
  };
}

function makeBackend(optimize: BackendClient["optimize"]): BackendClient {
  const reject = () => Promise.reject(new Error("not used"));
  return {
    intent: reject as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: reject as unknown as BackendClient["verify"],
    optimize,
    appendEvent: (async () => undefined) as unknown as BackendClient["appendEvent"],
    createSession: (async () => ({ id: "s1" })) as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
  };
}

/** Build an orchestrator already sitting at the approval gate with `alloc`. */
async function atApproval(optimize: BackendClient["optimize"]): Promise<Orchestrator> {
  const orch = new Orchestrator(makeBackend(optimize), {
    sessionId: "s1",
    retryDelayMs: 0,
  });
  await orch.start(REQUEST);
  orch.recordQuote(quote());
  await orch.optimize();
  return orch;
}

describe("ComparisonPage", () => {
  it("renders the allocation in rupees with each line reason and the saving", async () => {
    const orch = await atApproval(async () => allocation(12300));
    render(<ComparisonPage orchestrator={orch} />);

    expect(screen.getByTestId("grand-total")).toHaveTextContent("₹123");
    expect(screen.getByTestId("reason-hyperpure-potato")).toHaveTextContent(
      "cheaper on Hyperpure",
    );
    expect(screen.getByTestId("saving")).toHaveTextContent("You save ₹20");
  });

  it("Modify → editing a line re-optimizes and re-renders the new allocation", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce(allocation(12300))
      .mockResolvedValueOnce(allocation(9900));
    const orch = await atApproval(optimize as unknown as BackendClient["optimize"]);
    render(<ComparisonPage orchestrator={orch} />);

    expect(screen.getByTestId("grand-total")).toHaveTextContent("₹123");

    fireEvent.click(screen.getByTestId("modify-button"));
    fireEvent.click(screen.getByTestId("qty-inc-potato"));

    await waitFor(() =>
      expect(screen.getByTestId("grand-total")).toHaveTextContent("₹99"),
    );
    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it("Proceed fires approve() and shows the approved state", async () => {
    const orch = await atApproval(async () => allocation(12300));
    const approveSpy = vi.spyOn(orch, "approve");
    render(<ComparisonPage orchestrator={orch} />);

    fireEvent.click(screen.getByTestId("proceed-button"));

    expect(approveSpy).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("approved-note")).toBeInTheDocument(),
    );
  });

  it("Cancel cancels the session and never approves", async () => {
    const orch = await atApproval(async () => allocation(12300));
    const approveSpy = vi.spyOn(orch, "approve");
    render(<ComparisonPage orchestrator={orch} />);

    fireEvent.click(screen.getByTestId("cancel-button"));

    await waitFor(() =>
      expect(screen.getByTestId("cancelled-note")).toBeInTheDocument(),
    );
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("read back invokes the injected speak fn with the explanation", async () => {
    const orch = await atApproval(async () => allocation(12300));
    const speak = vi.fn();
    render(<ComparisonPage orchestrator={orch} speak={speak} />);

    fireEvent.click(screen.getByTestId("readback-button"));

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toContain("Grand total");
  });
});

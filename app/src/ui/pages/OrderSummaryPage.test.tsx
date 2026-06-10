import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OrderAttempt } from "../../core/domain/types";
import { OrderSummaryPage } from "./OrderSummaryPage";

const PLACED: OrderAttempt = {
  platform: "hyperpure",
  status: "placed",
  totalPaise: 5000,
  paidOnCredit: true,
  orderRef: "HP-ORDER-9988",
  idempotencyKey: "hyperpure-abc",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:05.000Z",
};

const PAID_AMAZON: OrderAttempt = {
  platform: "amazon",
  status: "placed",
  totalPaise: 7500,
  paidOnCredit: false,
  orderRef: "AMZ-112233",
  idempotencyKey: "amazon-xyz",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:05.000Z",
};

describe("OrderSummaryPage", () => {
  it("renders per-platform reference numbers and totals", () => {
    render(<OrderSummaryPage attempts={[PLACED, PAID_AMAZON]} />);

    expect(screen.getByTestId("receipt-ref-hyperpure")).toHaveTextContent("HP-ORDER-9988");
    expect(screen.getByTestId("receipt-total-hyperpure")).toHaveTextContent("₹50");
    expect(screen.getByTestId("receipt-ref-amazon")).toHaveTextContent("AMZ-112233");
    expect(screen.getByTestId("receipt-total-amazon")).toHaveTextContent("₹75");
  });

  it("distinguishes paid-on-credit from paid-at-checkout", () => {
    render(<OrderSummaryPage attempts={[PLACED, PAID_AMAZON]} />);
    expect(screen.getByTestId("receipt-payment-hyperpure")).toHaveTextContent("Paid on credit");
    expect(screen.getByTestId("receipt-payment-amazon")).toHaveTextContent("Paid at checkout");
  });

  it("shows the grand total across placed orders", () => {
    render(<OrderSummaryPage attempts={[PLACED, PAID_AMAZON]} />);
    expect(screen.getByTestId("summary-grand-total")).toHaveTextContent("₹125");
    expect(screen.getByTestId("summary-headline")).toHaveTextContent("All orders placed");
  });

  it("reflects a failed attempt without a reference", () => {
    const failed: OrderAttempt = {
      ...PLACED,
      status: "failed",
      orderRef: undefined,
    };
    render(<OrderSummaryPage attempts={[failed]} />);
    expect(screen.getByTestId("receipt-noref-hyperpure")).toBeInTheDocument();
    expect(screen.getByTestId("summary-headline")).toHaveTextContent("0 of 1 orders placed");
  });

  it("handles the empty state", () => {
    render(<OrderSummaryPage attempts={[]} />);
    expect(screen.getByTestId("summary-empty")).toBeInTheDocument();
  });
});

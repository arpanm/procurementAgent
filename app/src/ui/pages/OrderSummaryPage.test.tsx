import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("renders staged carts with a 'Review & checkout' hand-off button", () => {
    const staged: OrderAttempt = {
      platform: "amazon",
      status: "cart_filled",
      totalPaise: 9900,
      paidOnCredit: false,
      idempotencyKey: "amazon-stage",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      cartUrl: "https://www.amazon.in/gp/cart/view.html",
      stagedLineCount: 1,
    };
    const onOpenCart = vi.fn();
    render(<OrderSummaryPage attempts={[staged]} onOpenCart={onOpenCart} />);

    expect(screen.getByTestId("summary-headline")).toHaveTextContent("Your cart is ready");
    expect(screen.getByTestId("staged-amazon")).toHaveTextContent("1 item added");
    // The hand-off affordance is explicit "Review & checkout on {platform}" copy (pre-refactor lock).
    const review = screen.getByTestId("review-amazon");
    expect(review).toHaveTextContent("Review & checkout on Amazon.in");

    // Enabled when a cart URL + handler are present — clicking hands the platform back to the user.
    fireEvent.click(review);
    expect(onOpenCart).toHaveBeenCalledWith("amazon");
  });

  it("lists items the agent couldn't add and opens the product page on tap", () => {
    const staged: OrderAttempt = {
      platform: "amazon",
      status: "cart_filled",
      totalPaise: 23700,
      paidOnCredit: false,
      idempotencyKey: "k",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      cartUrl: "https://www.amazon.in/gp/cart/view.html",
      stagedLineCount: 1,
      stagedLines: [
        { canonicalItemId: "paneer", itemName: "paneer", skuId: "B018E0LQ8W", qty: 6, status: "added" },
        {
          canonicalItemId: "butter",
          itemName: "butter",
          skuId: "B0BUTTER01",
          qty: 2,
          status: "failed",
          productUrl: "https://www.amazon.in/dp/B0BUTTER01",
          reason: "no add-to-cart button",
        },
      ],
    };
    const onOpenProduct = vi.fn();
    render(
      <OrderSummaryPage attempts={[staged]} onOpenCart={vi.fn()} onOpenProduct={onOpenProduct} />,
    );

    expect(screen.getByTestId("staged-failed-amazon")).toHaveTextContent("couldn't add 1 item");
    const addBtn = screen.getByTestId("add-manually-amazon-butter");
    expect(addBtn).toHaveTextContent("Open butter (2)");
    fireEvent.click(addBtn);
    expect(onOpenProduct).toHaveBeenCalledWith("amazon", "https://www.amazon.in/dp/B0BUTTER01");
  });

  it("disables the hand-off button when no cart URL is available", () => {
    const staged: OrderAttempt = {
      platform: "amazon",
      status: "cart_filled",
      totalPaise: 9900,
      paidOnCredit: false,
      idempotencyKey: "amazon-stage",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:05.000Z",
      stagedLineCount: 0,
    };
    render(<OrderSummaryPage attempts={[staged]} />);
    expect(screen.getByTestId("review-amazon")).toBeDisabled();
  });
});

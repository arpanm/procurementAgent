import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  advanceAllHandoffs,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * The full happy-path journey in demo mode (`/flow?demo=1`):
 *   order → quoting → Comparison (savings hero + per-platform allocation) → Proceed/Approve →
 *   checkout → OTP hand-off → advance → payment hand-off → advance → order summary/receipt.
 *
 * Only the automation transport is mocked; the real orchestrator, checkout driver, Verifier safety
 * gate, and live `/intent` `/plan` `/optimize` `/verify` backend calls all run unchanged.
 */
test("drives the whole order → checkout → summary journey", async ({ page }) => {
  await gotoFlow(page, { demo: true });

  // Chat → parse order.
  await sendOrder(page, DEMO_ORDER);
  await confirmOrder(page);

  // Comparison: a savings hero + a genuine per-platform allocation.
  await expectComparison(page);
  await expect(page.getByTestId("saving")).toContainText("You save");
  await expect(page.getByTestId("platform-hyperpure")).toBeVisible();
  await expect(page.getByTestId("platform-amazon")).toBeVisible();

  // Approve → checkout hand-offs.
  await page.getByTestId("proceed-button").click();

  // First hand-off is OTP.
  await expect(page.getByTestId("handoff-prompt")).toBeVisible();
  await expect(page.getByTestId("reveal-button")).toBeVisible();

  // Advance through every OTP/payment hand-off until the summary renders.
  await advanceAllHandoffs(page);

  // Order summary / receipts.
  await expect(page.getByTestId("summary-headline")).toContainText("All orders placed");
  await expect(page.getByTestId("receipt-hyperpure")).toBeVisible();
  await expect(page.getByTestId("receipt-amazon")).toBeVisible();
  await expect(page.getByTestId("receipt-status-hyperpure")).toContainText("Order placed");
  await expect(page.getByTestId("summary-grand-total")).toContainText("₹");
});

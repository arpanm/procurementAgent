import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * The payment hand-off: after the OTP gate, the first platform's checkout hits a payment gate. The
 * screen shows the amount due and the trust note (we never handle the card). Advancing continues.
 */
test("shows the payment hand-off with amount + trust note and advances", async ({ page }) => {
  await gotoFlow(page, { demo: true });
  await sendOrder(page, DEMO_ORDER);
  await confirmOrder(page);
  await expectComparison(page);

  await page.getByTestId("proceed-button").click();

  // Clear the OTP gate first.
  await expect(page.getByText("Enter OTP")).toBeVisible();
  await page.getByTestId("done-button").click();

  // Payment hand-off screen for the same platform: amount due + trust note.
  await expect(page.getByText("Complete payment")).toBeVisible();
  await expect(page.getByTestId("handoff-amount")).toBeVisible();
  await expect(page.getByTestId("handoff-amount")).toContainText("₹");
  await expect(page.getByTestId("handoff-amount")).toContainText("due");
  await expect(page.getByText("We never handle your card.")).toBeVisible();

  // Advancing continues the flow off the payment screen.
  await page.getByTestId("done-button").click();
  await expect(page.getByTestId("handoff-amount")).toBeHidden();
});

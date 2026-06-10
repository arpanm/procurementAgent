import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * Cancelling from the Comparison screen places nothing and returns to the chat/idle surface.
 */
test("cancel from comparison returns to the chat surface", async ({ page }) => {
  await gotoFlow(page, { demo: true });
  await sendOrder(page, DEMO_ORDER);
  await confirmOrder(page);
  await expectComparison(page);

  await page.getByTestId("cancel-button").click();

  // Back to the conversation surface (idle chat), not on an order/checkout screen.
  await expect(page.getByTestId("order-input")).toBeVisible();
  await expect(page.getByTestId("proceed-button")).toHaveCount(0);
});

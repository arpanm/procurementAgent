import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * Modify / re-optimize from the Comparison screen: enter edit mode, change a line's quantity, and the
 * orchestrator RE-OPTIMIZES (never places) so the comparison updates with a new grand total. Demo
 * quotes: rice ₹90 on Hyperpure + 2 eggs ₹90 on Amazon = ₹270; bumping rice to qty 2 → ₹360.
 */
test("modifying a quantity re-optimizes and updates the comparison", async ({ page }) => {
  await gotoFlow(page, { demo: true });
  await sendOrder(page, DEMO_ORDER);
  await confirmOrder(page);
  await expectComparison(page);

  await expect(page.getByTestId("grand-total")).toContainText("₹270");

  // Enter edit mode and bump rice quantity; this triggers orchestrator.modify → re-optimize.
  await page.getByTestId("modify-button").click();
  await page.getByTestId("qty-inc-rice").click();

  // Comparison updates with the re-optimized total (still on the approval screen, nothing placed).
  await expect(page.getByTestId("grand-total")).toContainText("₹360");
  await expect(page.getByTestId("proceed-button")).toBeVisible();
});

import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * The optimizer must produce a genuine split across BOTH platforms with a non-zero saving. The demo
 * quotes price item 0 (rice) cheapest on Hyperpure and item 1 (egg) cheapest on Amazon, so the
 * greedy optimizer allocates one line to each platform and reports a saving vs a single platform.
 */
test("comparison allocates across both platforms with a non-zero saving", async ({ page }) => {
  await gotoFlow(page, { demo: true });
  await sendOrder(page, DEMO_ORDER);
  await confirmOrder(page);
  await expectComparison(page);

  // A line on Hyperpure AND a line on Amazon (a real cross-platform split).
  await expect(page.getByTestId("line-hyperpure-rice")).toBeVisible();
  await expect(page.getByTestId("line-amazon-egg")).toBeVisible();

  // Per-platform totals are present for both.
  await expect(page.getByTestId("platform-total-hyperpure")).toBeVisible();
  await expect(page.getByTestId("platform-total-amazon")).toBeVisible();

  // A non-zero, positive saving figure is surfaced.
  const saving = page.getByTestId("saving");
  await expect(saving).toContainText("You save");
  await expect(saving).toContainText("₹");
  await expect(saving).not.toContainText("You save ₹0");
});

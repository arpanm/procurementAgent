import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * Editing mechanics on the chat surface: example chip → composer, qty stepper, delete, add-item, and
 * Confirm advancing the flow. Runs in demo mode so Confirm leads cleanly into the deterministic
 * quoting/optimize journey (real `/intent` still parses the order).
 */
test.describe("chat editing", () => {
  test("an example chip fills the composer", async ({ page }) => {
    await gotoFlow(page, { demo: true });
    const input = page.getByTestId("order-input").locator("input");
    await expect(input).toHaveValue("");

    await page.getByText("10kg onions, 5kg paneer").click();
    await expect(input).toHaveValue("10kg onions, 5kg paneer");
  });

  test("qty stepper, delete, add-item edit the parsed list and Confirm advances", async ({
    page,
  }) => {
    await gotoFlow(page, { demo: true });
    await sendOrder(page, DEMO_ORDER);

    // Two parsed items: rice then egg.
    await expect(page.getByTestId("item-0")).toBeVisible();
    await expect(page.getByTestId("item-1")).toBeVisible();

    // Qty stepper +/- updates the displayed quantity (rice starts at 1).
    await expect(page.getByTestId("qty-value-0")).toHaveText("1");
    await page.getByTestId("qty-increment-0").click();
    await expect(page.getByTestId("qty-value-0")).toHaveText("2");
    await page.getByTestId("qty-decrement-0").click();
    await expect(page.getByTestId("qty-value-0")).toHaveText("1");

    // Delete removes the second item.
    await page.getByTestId("remove-1").click();
    await expect(page.getByTestId("item-1")).toHaveCount(0);
    await expect(page.getByTestId("item-0")).toBeVisible();

    // Add-item appends a blank row.
    await page.getByTestId("add-item-button").click();
    await expect(page.getByTestId("item-1")).toBeVisible();

    // Re-send a clean order so the demo journey has real items, then Confirm advances out of chat.
    await sendOrder(page, DEMO_ORDER);
    await confirmOrder(page);
    await expectComparison(page);
  });
});

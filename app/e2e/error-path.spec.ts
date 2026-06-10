import { expect, test } from "@playwright/test";
import { DEMO_ORDER, fillOrder, gotoFlow } from "./support/helpers";

/**
 * Error path: when `POST /intent` fails, the chat surface shows the friendly error banner and the app
 * keeps running (no crash, composer still usable). We intercept the request and fulfill a 500.
 */
test("a failing POST /intent shows the friendly error banner without crashing", async ({ page }) => {
  await page.route("**/intent", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "boom" }),
    }),
  );

  await gotoFlow(page);
  await expect(page.getByTestId("order-input")).toBeVisible();

  await fillOrder(page, DEMO_ORDER);
  await page.getByTestId("send-button").click();

  // Friendly error banner (role=alert), not a white screen.
  const errorNote = page.getByTestId("error-note");
  await expect(errorNote).toBeVisible();
  await expect(errorNote).toContainText("Something went wrong reading your order");

  // App still alive: the composer is still interactive.
  await expect(page.getByTestId("order-input")).toBeVisible();
  await expect(page.getByTestId("send-button")).toBeEnabled();
});

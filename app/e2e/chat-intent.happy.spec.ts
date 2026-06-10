import { expect, test } from "@playwright/test";
import { DEMO_ORDER, fillOrder, gotoFlow } from "./support/helpers";

/**
 * REGRESSION GUARD for the real-browser fetch-binding bug (`BackendClient` default `fetchImpl`).
 *
 * This spec uses NO request mocking: it drives the real `HttpBackendClient` default transport against
 * the live stub backend, so a `TypeError: Illegal invocation` (or any fetch-binding regression) would
 * surface here even though all 155 jsdom unit tests miss it.
 */
test("parses a real order via a live POST /intent with no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await gotoFlow(page);
  await expect(page.getByTestId("order-input")).toBeVisible();

  // Assert a REAL request to the backend /intent endpoint actually fires (the fetch binding works).
  const intentResponsePromise = page.waitForResponse(
    (res) => res.url().includes("localhost:8080/intent") && res.request().method() === "POST",
  );

  await fillOrder(page, DEMO_ORDER);
  await page.getByTestId("send-button").click();

  const intentResponse = await intentResponsePromise;
  expect(intentResponse.status()).toBe(200);

  // The parsed item cards render from the real /intent → 200 response.
  await expect(page.getByTestId("item-list")).toBeVisible();
  await expect(page.getByTestId("item-name-0")).toContainText("rice");
  await expect(page.getByTestId("item-name-1")).toContainText("egg");

  expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});

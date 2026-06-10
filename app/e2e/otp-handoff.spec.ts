import { expect, test } from "@playwright/test";
import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  gotoFlow,
  sendOrder,
} from "./support/helpers";

/**
 * The OTP hand-off: when checkout hits an OTP gate the flow PAUSES and shows the hand-off screen with
 * its prompt and the reveal / "I've done this" controls. Procure Copilot never types the OTP — the
 * screen only reveals the live site and resumes when the human confirms. Advancing continues the flow.
 */
test("shows the OTP hand-off and advances on confirm", async ({ page }) => {
  await gotoFlow(page, { demo: true });
  await sendOrder(page, DEMO_ORDER);
  await confirmOrder(page);
  await expectComparison(page);

  await page.getByTestId("proceed-button").click();

  // OTP hand-off screen (no amount chip on an OTP gate).
  await expect(page.getByText("Enter OTP")).toBeVisible();
  await expect(page.getByTestId("handoff-prompt")).toContainText("OTP");
  await expect(page.getByTestId("reveal-button")).toContainText("Show me");
  await expect(page.getByTestId("handoff-amount")).toHaveCount(0);

  // Reveal control toggles (engine.show()).
  await page.getByTestId("reveal-button").click();
  await expect(page.getByTestId("reveal-button")).toHaveAttribute("aria-pressed", "true");

  // "I've done this" resumes the flow off the OTP screen.
  await page.getByTestId("done-button").click();
  await expect(page.getByText("Enter OTP")).toBeHidden();
});

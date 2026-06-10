import { expect, type Page } from "@playwright/test";

/** A demo order that the rule parser maps to `rice` (1) + `egg` (2) — see backend IntentService. */
export const DEMO_ORDER = "order 1kg basmati rice, 2 dozen eggs";

/** Navigate to the flow route. `demo` flips on the `?demo=1` deterministic automation seam. */
export async function gotoFlow(page: Page, opts: { demo?: boolean } = {}): Promise<void> {
  await page.goto(opts.demo ? "/flow?demo=1" : "/flow");
}

/** Type into the Ionic composer (pierces the ion-input shadow DOM to reach the native input). */
export async function fillOrder(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("order-input").locator("input");
  await input.click();
  await input.fill(text);
}

/** Fill the composer, hit Send, and wait for the parsed item list to render. */
export async function sendOrder(page: Page, text: string): Promise<void> {
  await fillOrder(page, text);
  const send = page.getByTestId("send-button");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("item-list")).toBeVisible();
}

/** Confirm the parsed order, advancing the flow out of the chat surface. */
export async function confirmOrder(page: Page): Promise<void> {
  await page.getByTestId("confirm-button").click();
}

/** Wait for the Comparison/approval screen (after demo quoting + optimize). */
export async function expectComparison(page: Page): Promise<void> {
  await expect(page.getByTestId("allocation-card")).toBeVisible();
  await expect(page.getByTestId("proceed-button")).toBeVisible();
}

/**
 * Advance every OTP/payment hand-off until the order summary renders. With two platforms the demo
 * surfaces OTP → payment per platform; we click "I've done this" each time. Between hand-offs the flow
 * briefly transitions, so we poll until we are definitively on a hand-off (click) or the summary
 * (stop), ignoring transient intermediate renders. Bounded so a stuck flow fails fast.
 */
export async function advanceAllHandoffs(page: Page): Promise<void> {
  const summary = page.getByTestId("summary-headline");
  const done = page.getByTestId("done-button");

  for (let i = 0; i < 8; i++) {
    await expect
      .poll(
        async () => {
          if (await summary.isVisible().catch(() => false)) return "summary";
          if (await done.isVisible().catch(() => false)) return "handoff";
          return "pending";
        },
        { timeout: 15_000 },
      )
      .not.toBe("pending");

    if (await summary.isVisible().catch(() => false)) {
      return;
    }
    await done.click();
  }
  await expect(summary).toBeVisible();
}

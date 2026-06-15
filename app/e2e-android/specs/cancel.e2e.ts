import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  expectGoneTid,
  launchFlow,
  sendOrder,
  tapTestId,
  waitVisibleTid,
} from "../support/helpers.js";

/**
 * Cancelling from the Comparison screen places nothing and returns to the chat/idle surface.
 *
 * Port of `app/e2e/cancel.spec.ts`.
 */
describe("cancel", () => {
  beforeEach(launchFlow);

  it("cancel from comparison returns to the chat surface", async () => {
    await sendOrder(DEMO_ORDER);
    await confirmOrder();
    await expectComparison();

    await tapTestId("cancel-button");

    // Back to the conversation surface (idle chat), not on an order/checkout screen.
    await waitVisibleTid("order-input", 30_000);
    await expectGoneTid("proceed-button");
  });
});

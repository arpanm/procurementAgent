import {
  DEMO_ORDER,
  clickByText,
  confirmOrder,
  expectComparison,
  expectExactTid,
  expectGoneTid,
  expectOrderInputValue,
  expectVisibleTid,
  launchFlow,
  orderInputValue,
  sendOrder,
  tapTestId,
  expect,
} from "../support/helpers.js";

/**
 * Editing mechanics on the chat surface: example chip → composer, qty stepper, delete, add-item, and
 * Confirm advancing the flow. Runs in demo mode so Confirm leads cleanly into the deterministic
 * quoting/optimize journey (real `/intent` still parses the order).
 *
 * Port of `app/e2e/chat-editing.spec.ts`.
 */
describe("chat editing", () => {
  beforeEach(launchFlow);

  it("an example chip fills the composer", async () => {
    expect(await orderInputValue()).toBe("");

    await clickByText("10kg onions, 5kg paneer");

    await expectOrderInputValue("10kg onions, 5kg paneer");
  });

  it("qty stepper, delete, add-item edit the parsed list and Confirm advances", async () => {
    await sendOrder(DEMO_ORDER);

    // Two parsed items: rice then egg.
    await expectVisibleTid("item-0");
    await expectVisibleTid("item-1");

    // Qty stepper +/- updates the displayed quantity (rice starts at 1).
    await expectExactTid("qty-value-0", "1");
    await tapTestId("qty-increment-0");
    await expectExactTid("qty-value-0", "2");
    await tapTestId("qty-decrement-0");
    await expectExactTid("qty-value-0", "1");

    // Delete removes the second item.
    await tapTestId("remove-1");
    await expectGoneTid("item-1");
    await expectVisibleTid("item-0");

    // Add-item appends a blank row.
    await tapTestId("add-item-button");
    await expectVisibleTid("item-1");

    // Re-send a clean order so the demo journey has real items, then Confirm advances out of chat.
    await sendOrder(DEMO_ORDER);
    await confirmOrder();
    await expectComparison();
  });
});

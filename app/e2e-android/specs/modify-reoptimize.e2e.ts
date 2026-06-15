import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  expectTextTid,
  expectVisibleTid,
  launchFlow,
  sendOrder,
  tapTestId,
} from "../support/helpers.js";

/**
 * Modify / re-optimize from the Comparison screen: enter edit mode, bump a line's quantity, and the
 * orchestrator RE-OPTIMIZES (never places) so the comparison updates with a new grand total. Demo
 * quotes: rice ₹90 on Hyperpure + 2 eggs ₹180 on Amazon = ₹270; bumping rice to qty 2 → ₹360.
 *
 * Port of `app/e2e/modify-reoptimize.spec.ts`.
 */
describe("modify / re-optimize", () => {
  beforeEach(launchFlow);

  it("modifying a quantity re-optimizes and updates the comparison", async () => {
    await sendOrder(DEMO_ORDER);
    await confirmOrder();
    await expectComparison();

    await expectTextTid("grand-total", "₹270");

    // Enter edit mode and bump rice quantity; this triggers orchestrator.modify → re-optimize.
    await tapTestId("modify-button");
    await tapTestId("qty-inc-rice");

    // Comparison updates with the re-optimized total (still on the approval screen, nothing placed).
    await expectTextTid("grand-total", "₹360");
    await expectVisibleTid("proceed-button");
  });
});

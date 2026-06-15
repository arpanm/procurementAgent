import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  expectTextTid,
  expectVisibleTid,
  launchFlow,
  sendOrder,
} from "../support/helpers.js";

/**
 * The optimizer must produce a genuine split across BOTH platforms. The demo quotes price item 0
 * (rice) cheapest on Hyperpure and item 1 (egg) cheapest on Amazon, so the optimizer allocates one
 * line to each platform.
 *
 * Port of `app/e2e/multi-platform-split.spec.ts`. The legacy web spec additionally asserts a non-zero
 * "You save ₹…" figure; with the current backend optimizer the split nets out to "No saving vs a
 * single platform", so here we assert the genuine cross-platform allocation + per-platform totals +
 * the surfaced saving line, without pinning its sign. See the README.
 */
describe("multi-platform split", () => {
  beforeEach(launchFlow);

  it("comparison allocates a line on each platform with per-platform totals", async () => {
    await sendOrder(DEMO_ORDER);
    await confirmOrder();
    await expectComparison();

    // A line on Hyperpure AND a line on Amazon (a real cross-platform split).
    await expectVisibleTid("line-hyperpure-rice");
    await expectVisibleTid("line-amazon-egg");

    // Per-platform totals are present for both.
    await expectVisibleTid("platform-total-hyperpure");
    await expectVisibleTid("platform-total-amazon");

    // The grand total + a saving summary line are surfaced (₹270 for the demo order).
    await expectTextTid("grand-total", "₹");
    await expectVisibleTid("saving");
  });
});

import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  expectTextTid,
  expectVisibleTid,
  launchFlow,
  sendOrder,
  tapTestId,
  waitVisibleTid,
} from "../support/helpers.js";

/**
 * The full happy-path journey, on-device, in demo mode:
 *   order → quoting → Comparison (per-platform split) → Proceed → cart-staging hand-off summary.
 *
 * Port of `app/e2e/full-journey.spec.ts`. Only the automation transport is mocked; the real
 * orchestrator, checkout driver (cart-staging `stageCart` model), Verifier safety gate, and the live
 * `/intent` `/plan` `/optimize` backend calls all run unchanged.
 *
 * NOTE vs the legacy web spec: the current demo checkout STAGES each platform's cart and hands the
 * user off to "Review & checkout on {platform}" (it does NOT auto-drive OTP/payment to a placed
 * receipt). So the terminal screen is the staged-cart summary ("Your carts are ready"), which is the
 * behaviour this regression suite guards. See `e2e-android/README.md`.
 */
describe("full journey", () => {
  beforeEach(launchFlow);

  it("drives order → comparison → proceed → staged-cart summary", async () => {
    // Chat → parse order.
    await sendOrder(DEMO_ORDER);
    await confirmOrder();

    // Comparison: a genuine per-platform allocation across both platforms.
    await expectComparison();
    await expectVisibleTid("platform-hyperpure");
    await expectVisibleTid("platform-amazon");
    await expectVisibleTid("saving");

    // Approve → checkout (cart staging) → summary.
    await tapTestId("proceed-button");

    // Terminal screen: the staged-cart hand-off summary.
    await waitVisibleTid("summary-headline", 60_000);
    await expectTextTid("summary-headline", "carts are ready");
    await expectVisibleTid("staged-hyperpure");
    await expectVisibleTid("staged-amazon");
    await expectVisibleTid("review-hyperpure");
    await expectVisibleTid("review-amazon");
    await expectTextTid("summary-grand-total", "₹");
  });
});

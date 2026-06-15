import {
  DEMO_ORDER,
  confirmOrder,
  expectComparison,
  expectTextTid,
  launchFlow,
  sendOrder,
  tapTestId,
} from "../support/helpers.js";

/**
 * Port of `app/e2e/otp-handoff.spec.ts`.
 *
 * SKIPPED (not applicable to the current demo checkout model). The legacy spec asserts an automated
 * OTP gate ("Enter OTP" + reveal/done controls) during checkout. The current `ProcureFlow` uses the
 * cart-STAGING hand-off (`CheckoutDriver.stageCart`): after Proceed it best-effort adds items to each
 * platform's cart and hands the user off to "Review & checkout on {platform}" — it never drives an
 * OTP/payment gate in demo mode, so this screen is unreachable. The same divergence makes the legacy
 * web `otp-handoff.spec.ts` fail in this working tree (see `e2e-android/README.md`).
 *
 * Re-enable (change `describe.skip` → `describe`) if/when the demo flow drives the OTP/payment
 * checkout path (`CheckoutDriver.run`) again.
 */
describe.skip("OTP hand-off (not applicable to cart-staging checkout)", () => {
  beforeEach(launchFlow);

  it("shows the OTP hand-off and advances on confirm", async () => {
    await sendOrder(DEMO_ORDER);
    await confirmOrder();
    await expectComparison();

    await tapTestId("proceed-button");

    await expectTextTid("handoff-prompt", "OTP");
    await expectTextTid("reveal-button", "Show me");

    await tapTestId("reveal-button");
    await tapTestId("done-button");
  });
});

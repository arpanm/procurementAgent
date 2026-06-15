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
 * Port of `app/e2e/payment-handoff.spec.ts`.
 *
 * SKIPPED (not applicable to the current demo checkout model) — same reason as `otp-handoff.e2e.ts`:
 * the current `ProcureFlow` stages carts and hands off to manual "Review & checkout", so the
 * automated payment gate ("Complete payment" + amount chip + trust note) is unreachable in demo mode.
 * The legacy web `payment-handoff.spec.ts` fails in this working tree for the same reason. See
 * `e2e-android/README.md`. Re-enable when the OTP/payment checkout path returns.
 */
describe.skip("payment hand-off (not applicable to cart-staging checkout)", () => {
  beforeEach(launchFlow);

  it("shows the payment hand-off with amount + trust note and advances", async () => {
    await sendOrder(DEMO_ORDER);
    await confirmOrder();
    await expectComparison();

    await tapTestId("proceed-button");

    // Clear the OTP gate first, then assert the payment gate.
    await tapTestId("done-button");
    await expectTextTid("handoff-amount", "₹");
    await expectTextTid("handoff-amount", "due");

    await tapTestId("done-button");
  });
});

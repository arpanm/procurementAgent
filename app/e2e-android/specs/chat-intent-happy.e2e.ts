import {
  DEMO_ORDER,
  expectTextTid,
  expectVisibleTid,
  launchFlow,
  sendOrder,
} from "../support/helpers.js";

/**
 * REGRESSION GUARD for the real-device fetch path (`HttpBackendClient` over the emulator's
 * `10.0.2.2` / `adb reverse` loopback).
 *
 * Port of `app/e2e/chat-intent.happy.spec.ts`. The web spec asserts a real `POST /intent` 200 by
 * sniffing the network response + console; inside an Appium WebView we assert the equivalent
 * OBSERVABLE outcome: the parsed item cards render straight from the live stub backend's `/intent`
 * response (rice + egg). If the on-device fetch were broken (wrong host, cleartext blocked,
 * fetch-binding regression) no items would render and this fails.
 */
describe("chat → intent (happy path)", () => {
  beforeEach(launchFlow);

  it("parses a real order via a live POST /intent and renders the items", async () => {
    await expectVisibleTid("order-input");

    await sendOrder(DEMO_ORDER);

    await expectTextTid("item-name-0", "rice");
    await expectTextTid("item-name-1", "egg");
  });
});

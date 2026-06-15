import {
  DEMO_ORDER,
  expectTextTid,
  expectVisibleTid,
  fillOrder,
  launchFlow,
  tapTestId,
} from "../support/helpers.js";

/**
 * Port of `app/e2e/error-path.spec.ts`.
 *
 * SKIPPED on the emulator (environment limitation, not an app bug). The web spec uses Playwright
 * request interception (`page.route("**\/intent", fulfill 500)`) to force a `/intent` failure and
 * assert the friendly error banner. An Appium WebView has no equivalent in-process request mock, and
 * the app is self-healing about connectivity: it probes BOTH `http://localhost:8080` (via
 * `adb reverse`) AND `http://10.0.2.2:8080` (the emulator's host loopback), so simply toggling the
 * device's radio/Wi-Fi or dropping the `adb reverse` tunnel does NOT make `/intent` fail — the other
 * candidate still reaches the host backend.
 *
 * To exercise this deterministically on-device, build a dedicated demo APK pointed at a dead backend
 * (e.g. `VITE_BACKEND_URL=http://10.0.2.2:9 VITE_DEMO=1 VITE_DEBUG_AUTOMATION=0 npm run build`,
 * `cap sync android`, assembleDebug) and run only this spec; then both candidates fail and the
 * `error-note` banner renders. See `e2e-android/README.md`.
 */
describe.skip("error path (needs a dead-backend build on the emulator)", () => {
  beforeEach(launchFlow);

  it("a failing POST /intent shows the friendly error banner without crashing", async () => {
    await fillOrder(DEMO_ORDER);
    await tapTestId("send-button");

    await expectTextTid("error-note", "Something went wrong reading your order", 30_000);

    // App still alive: the composer is still interactive.
    await expectVisibleTid("order-input");
  });
});

/**
 * WebdriverIO config for the Procure Copilot Android end-to-end regression suite.
 *
 * It drives the DEMO-mode debug APK (`VITE_DEMO=1`) installed on the running Android emulator via
 * Appium's UiAutomator2 driver. Each spec switches into the Capacitor WebView context
 * (`WEBVIEW_ai.procurecopilot.app`) and asserts against the same `data-testid`s the web Playwright
 * suite uses, so the on-device app is exercised exactly like production (real orchestrator, real
 * checkout driver, real `/intent` `/plan` `/optimize` `/verify` backend calls) — only the automation
 * transport is the deterministic in-memory `MockAutomationEngine`.
 *
 * Prerequisites (see `e2e-android/README.md`): an emulator named `emulator-5554`, the Spring Boot
 * backend running in stub mode on :8080, and the demo debug APK built (`npm run android:demo:build`).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The UiAutomator2 driver shells out to `adb`/`avdmanager`, which require `ANDROID_HOME` (or
 * `ANDROID_SDK_ROOT`) to be exported — otherwise session creation fails with
 * "Neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable was exported". The interactive
 * shell may export it, but `npm run`/CI often don't, so make the suite self-contained: honour an
 * existing value, else fall back to the conventional SDK install location.
 */
(() => {
  const existing = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const sdk =
    existing && existsSync(existing) ? existing : resolve(homedir(), "Library/Android/sdk");
  if (existsSync(sdk)) {
    process.env.ANDROID_HOME = sdk;
    process.env.ANDROID_SDK_ROOT = sdk;
    // Make `adb` (and friends) resolvable for any child process that searches PATH.
    const binDirs = [resolve(sdk, "platform-tools"), resolve(sdk, "emulator")].filter(existsSync);
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.PATH = [...binDirs, process.env.PATH ?? ""].join(sep);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[wdio] Android SDK not found at "${sdk}". Set ANDROID_HOME to your SDK before running.`,
    );
  }
})();

/** The demo debug APK produced by `npm run android:demo:build`. */
const APK_PATH = resolve(here, "../android/app/build/outputs/apk/debug/app-debug.apk");

/** The Capacitor application id (see `capacitor.config.ts`); the WebView context is derived from it. */
export const APP_PACKAGE = "ai.procurecopilot.app";

/** The Chromium WebView context Appium exposes for the Capacitor WebView. */
export const WEBVIEW_CONTEXT = `WEBVIEW_${APP_PACKAGE}`;

/** Target device serial. Overridable so CI can point at a differently-named AVD. */
const DEVICE = process.env.ANDROID_DEVICE ?? "emulator-5554";

if (!existsSync(APK_PATH)) {
  // Fail loud + early with the exact remediation rather than a cryptic Appium "app not found".
  // eslint-disable-next-line no-console
  console.warn(
    `\n[wdio] Demo APK not found at:\n  ${APK_PATH}\n` +
      `Build it first:  npm run android:demo:build\n`,
  );
}

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: resolve(here, "tsconfig.json"),

  port: 4723,

  specs: [resolve(here, "specs/**/*.e2e.ts")],
  exclude: [],

  maxInstances: 1,

  // Cast: WDIO's typed capability surface doesn't enumerate every vendor `appium:*` key
  // (e.g. chromedriverAutodownload), but Appium accepts them at runtime.
  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": DEVICE,
      "appium:udid": DEVICE,
      "appium:app": APK_PATH,
      "appium:appPackage": APP_PACKAGE,
      // Boot straight into the app's launcher activity, then let the WebView settle.
      "appium:autoGrantPermissions": true,
      "appium:newCommandTimeout": 240,
      // Let Appium fetch the chromedriver that matches the emulator's System WebView automatically
      // (requires the server's relaxed-security / allow-insecure flag, set on the service below).
      "appium:chromedriverAutodownload": true,
      "appium:nativeWebScreenshot": true,
      // The emulator's WebView intermittently drops the chromedriver/CDP socket under load
      // ("session deleted as the browser has closed the connection"). Recreating the chromedriver
      // session on every context switch lets our helpers re-attach to a fresh, live session after a
      // drop (and after the deliberate reload in launchFlow) instead of reusing a dead one.
      "appium:recreateChromeDriverSessions": true,
      "appium:ensureWebviewsHavePages": true,
      // Reinstall a clean app per session but keep data within a session (we reset via JS reload).
      "appium:noReset": false,
      "appium:fullReset": false,
      // Always (re)install the APK we just built — otherwise Appium keeps a previously-installed build
      // when the package id matches, so a freshly rebuilt demo APK (e.g. after toggling a VITE_ flag)
      // would silently NOT reach the device.
      "appium:enforceAppInstall": true,
      // Some emulator images are slow to surface the WebView; give the session room to start.
      "appium:uiautomator2ServerLaunchTimeout": 120000,
      "appium:adbExecTimeout": 120000,
    },
  ] as unknown as WebdriverIO.Config["capabilities"],

  logLevel: "warn",
  bail: 0,
  waitforTimeout: 20000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 2,

  services: [
    [
      "appium",
      {
        args: {
          // Enable chromedriver auto-download + general insecure features for the WebView bridge.
          relaxedSecurity: true,
          allowInsecure: ["chromedriver_autodownload"],
        },
      },
    ],
  ],

  framework: "mocha",
  reporters: ["spec"],

  mochaOpts: {
    ui: "bdd",
    // VERY generous on purpose: every WebDriver round-trip through Appium → chromedriver → the
    // emulator's WebView costs ~1.5–2.5s on a cold AVD, so the multi-step full journey (intent →
    // quote → optimize → approve → per-platform OTP/payment hand-offs → summary) issues enough
    // commands to blow a tighter budget even though every step succeeds.
    timeout: 900000,
  },
};

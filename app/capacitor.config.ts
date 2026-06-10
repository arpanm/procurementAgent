import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.procurecopilot.app",
  appName: "Procure Copilot",
  webDir: "dist",
  // Android-only MVP (PROCURE_COPILOT_PLAN.md §13).
  android: {
    // DEV-ONLY: the app is served from the WebView's secure origin (https://localhost), but the local
    // backend is plain HTTP. Chromium exempts http://localhost from mixed-content blocking but NOT a
    // bare IP like http://10.0.2.2 (the emulator's host alias), so without this the device can reach the
    // backend over TCP yet the fetch is silently blocked. Allowing mixed content lets us hit 10.0.2.2
    // directly — no `adb reverse` tunnel required, so it survives emulator restarts.
    // For a real deployment, point the app at an HTTPS backend and set this back to false.
    allowMixedContent: true,
  },
};

export default config;

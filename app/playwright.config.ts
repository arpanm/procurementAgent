import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Procure Copilot e2e suite.
 *
 * The suite runs against the REAL Vite dev server (booted by `webServer` below) and a REAL Spring
 * Boot backend in stub mode (started separately — see `e2e/README.md`). Its #1 job is to catch
 * real-browser-only bugs (real `fetch`, real DOM, real module graph) that the jsdom unit tests miss.
 *
 * Demo-mode specs visit `/flow?demo=1`, which swaps ONLY the automation transport for a deterministic
 * in-memory engine so the full journey (which needs a Capacitor WebView in production) runs in
 * plain Chromium. The happy-path regression spec hits a real `POST /intent` with no mocking.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Boot the Vite dev server for the run; reuse an already-running one locally. The backend is
  // assumed to be running separately on :8080 (stub mode) — see e2e/README.md.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

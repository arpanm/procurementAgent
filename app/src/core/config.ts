/**
 * App-level configuration. The backend base URL is injected at build time; it defaults to the local
 * Spring Boot backend for development. The platform entry URLs are where each adapter's webview opens.
 */
import type { PlatformId } from "./domain/types";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/**
 * Candidate backend base URLs, tried in order until one is reachable (see `HttpBackendClient`). This is
 * what makes connectivity self-healing instead of depending on a fragile `adb reverse` tunnel:
 *   - `VITE_BACKEND_URL` (optional, comma-separated) — explicit override(s) first.
 *   - `http://10.0.2.2:8080` — the standard Android emulator alias for the host loopback; reaches the
 *     Mac's backend WITHOUT any tunnel on a normal AVD.
 *   - `http://localhost:8080` — works on web/desktop, and on a device with `adb reverse` set.
 * The client probes these and picks whichever responds, so an emulator restart / missing tunnel /
 * different device type can no longer strand the very first request.
 */
export const BACKEND_BASE_URLS: string[] = ((): string[] => {
  const configured = (env.VITE_BACKEND_URL ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const fallbacks = ["http://10.0.2.2:8080", "http://localhost:8080"];
  return [...configured, ...fallbacks].filter((u, i, a) => a.indexOf(u) === i);
})();

/** First candidate; kept for display/back-compat. Requests resolve the reachable one at runtime. */
export const BACKEND_BASE_URL: string = BACKEND_BASE_URLS[0];

export const PLATFORM_URLS: Record<PlatformId, string> = {
  hyperpure: "https://www.hyperpure.com",
  amazon: "https://www.amazon.in",
};

/**
 * Platforms the app actively drives (opens, logs into, searches, adds to cart). Amazon is currently
 * DISABLED: its mobile site serves an AWS-WAF bot-challenge that won't execute in the WebView (blank
 * screen, `AwsWafIntegration is not defined`, 0 elements), so it can't be sourced reliably. Keeping it
 * out of this list removes it from every stage — quoting, the loading pills, the optimizer, and
 * checkout — without deleting the AmazonAgent, so re-enabling later is a one-line change here. The
 * `VITE_ACTIVE_PLATFORMS` env (comma-separated) can override for experiments.
 */
export const ACTIVE_PLATFORMS: readonly PlatformId[] = ((): readonly PlatformId[] => {
  const known: PlatformId[] = ["hyperpure", "amazon"];
  const configured = (env.VITE_ACTIVE_PLATFORMS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is PlatformId => (known as string[]).includes(s));
  return configured.length > 0 ? configured : ["hyperpure"];
})();

/**
 * Each platform's cart URL. After the agent stages items (best-effort add-to-cart), checkout is handed
 * off to the user: the summary offers a "Review & checkout on {platform}" button that re-opens this
 * URL in the foreground (the logged-in WebView session) so the user can adjust and complete the order.
 */
export const PLATFORM_CART_URLS: Record<PlatformId, string> = {
  hyperpure: "https://www.hyperpure.com/in/cart",
  amazon: "https://www.amazon.in/gp/cart/view.html",
};

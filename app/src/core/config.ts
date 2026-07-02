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
// A RELEASE build (VITE_RELEASE=1) enforces the production networking rules. This is deliberately NOT
// `import.meta.env.PROD` — every `vite build` sets PROD, including the dev/emulator debug APKs that
// legitimately talk to an http backend over adb-reverse. Only a real store/release build sets VITE_RELEASE.
const IS_RELEASE = env.VITE_RELEASE === "1";

export const BACKEND_BASE_URLS: string[] = ((): string[] => {
  const configured = (env.VITE_BACKEND_URL ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  // Cleartext loopback fallbacks are DEV-ONLY — never ship them in a release build (a build that forgot
  // VITE_BACKEND_URL must not silently point the APK at localhost over cleartext).
  const fallbacks = IS_RELEASE ? [] : ["http://10.0.2.2:8080", "http://localhost:8080"];
  let urls = [...configured, ...fallbacks].filter((u, i, a) => a.indexOf(u) === i);
  if (IS_RELEASE) {
    // A release build must reach an HTTPS backend. Drop any cleartext URL and fail loudly if none remain.
    urls = urls.filter((u) => u.startsWith("https://"));
    if (urls.length === 0) {
      throw new Error(
        "VITE_BACKEND_URL must be set to an https:// backend URL for a release build (VITE_RELEASE=1).",
      );
    }
  }
  return urls;
})();

/** First candidate; kept for display/back-compat. Requests resolve the reachable one at runtime. */
export const BACKEND_BASE_URL: string = BACKEND_BASE_URLS[0];

/**
 * Optional bearer token sent as `Authorization: Bearer <token>` on every backend call (see
 * `HttpBackendClient`). Set `VITE_API_TOKEN` when the backend has `procure.security.api-token` configured
 * (production). Blank in local/dev/demo, where the backend leaves auth disabled.
 */
export const BACKEND_API_TOKEN: string = (env.VITE_API_TOKEN ?? "").trim();

export const PLATFORM_URLS: Record<PlatformId, string> = {
  hyperpure: "https://www.hyperpure.com",
  amazon: "https://www.amazon.in",
};

/**
 * The single source of truth for how each platform is NAMED in the UI. Use {@link platformLabel}
 * everywhere a platform is shown to the user so "Amazon.in" / "Hyperpure" never disagree across screens
 * (previously some components capitalized the raw id → "Amazon").
 */
export const PLATFORM_LABELS: Record<PlatformId, string> = {
  hyperpure: "Hyperpure",
  amazon: "Amazon.in",
};

/** Human label for a platform, falling back to the raw id for an unknown one. */
export function platformLabel(platform: PlatformId): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

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
  hyperpure: "https://www.hyperpure.com/buyer/cart",
  amazon: "https://www.amazon.in/gp/cart/view.html",
};

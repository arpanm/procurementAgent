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

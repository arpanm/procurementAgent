/**
 * Persisted "the user has manually signed in to this platform" flags.
 *
 * Retailer logins (Hyperpure/Amazon) require a human: phone OTP, captcha, delivery-location selection.
 * Rather than detect a login wall mid-scrape (fragile, and it re-prompted on every run), the app gates
 * the FIRST run behind an explicit step — the user opens each active platform's WebView, signs in + sets
 * their location, and confirms. That confirmation is stored here so subsequent runs skip straight to
 * search. The WebView's cookies persist in the shared Android WebView store, so the saved session stays
 * valid; this flag just records that the human did the one-time setup.
 *
 * Storage is `localStorage` (persists across app launches inside the Capacitor WebView). It holds only a
 * boolean per platform — never credentials, cookies, or OTPs (those live in the WebView/Keystore).
 */
import type { PlatformId } from "../domain/types";

const KEY_PREFIX = "pc.login.confirmed.";

function keyFor(platform: PlatformId): string {
  return `${KEY_PREFIX}${platform}`;
}

/** True if the user has confirmed a manual sign-in for `platform`. Safe on web/SSR (returns false). */
export function isLoginConfirmed(platform: PlatformId): boolean {
  try {
    return globalThis.localStorage?.getItem(keyFor(platform)) === "1";
  } catch {
    return false;
  }
}

/** Record that the user signed in to `platform` (idempotent). */
export function confirmLogin(platform: PlatformId): void {
  try {
    globalThis.localStorage?.setItem(keyFor(platform), "1");
  } catch {
    /* storage unavailable (private mode / SSR) — the gate will simply re-ask next launch */
  }
}

/** Forget the confirmation for one platform, or all known platforms when omitted ("sign out" / reset). */
export function resetLogin(platform?: PlatformId): void {
  const platforms: PlatformId[] = platform ? [platform] : ["hyperpure", "amazon"];
  try {
    for (const p of platforms) globalThis.localStorage?.removeItem(keyFor(p));
  } catch {
    /* ignore */
  }
}

/** True only when every platform in `platforms` has a stored confirmation. Empty list ⇒ true. */
export function allLoginsConfirmed(platforms: readonly PlatformId[]): boolean {
  return platforms.every(isLoginConfirmed);
}

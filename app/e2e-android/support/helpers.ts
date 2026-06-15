/**
 * Android (Appium + WebdriverIO) port of the web Playwright helpers (`app/e2e/support/helpers.ts`).
 *
 * Every spec drives the REAL app installed on the emulator. Two things shape this port:
 *
 *  1. WEBVIEW SEAM. An Appium session starts in the `NATIVE_APP` context, so before touching any DOM
 *     we switch into the Capacitor Chromium WebView (`WEBVIEW_ai.procurecopilot.app`) and from then on
 *     use ordinary WebView CSS selectors against the same `data-testid`s the web suite relies on.
 *
 *  2. ROUND-TRIP COST. Each Appium→chromedriver→emulator command costs ~2–3s here, so the classic
 *     WDIO pattern (findElement, then getComputedStyle, then checkVisibility — 3+ round-trips PER
 *     poll) is far too slow and blows past mocha timeouts. Instead every primitive below is a SINGLE
 *     `browser.execute` round-trip: one DOM query returns existence + visibility + text, taps are a
 *     JS `.click()` (which also dodges Ionic shadow-DOM + off-screen-footer issues), and `ion-input`
 *     is driven by reaching its shadow-root `<input>` and firing a React-friendly `input` event.
 */
import { browser, $$, expect } from "@wdio/globals";
import { APP_PACKAGE, WEBVIEW_CONTEXT } from "../wdio.conf.js";

/** A demo order that the rule parser maps to `rice` (1) + `egg` (2) — see backend IntentService. */
export const DEMO_ORDER = "order 1kg basmati rice, 2 dozen eggs";

const WEBVIEW_TIMEOUT = 90_000;

/** `[data-testid="…"]` selector for a testid. */
export const tid = (t: string): string => `[data-testid="${t}"]`;

interface Probe {
  readonly exists: boolean;
  readonly visible: boolean;
  readonly text: string;
  readonly ariaDisabled: string | null;
  readonly count: number;
}

/**
 * True for errors that mean the WebView's chromedriver/CDP session went away (a transient drop under
 * emulator load, or the deliberate reload in {@link launchFlow}). These are recoverable by switching
 * out of and back into the WebView context, which — with `appium:recreateChromeDriverSessions` —
 * spins up a brand-new chromedriver attached to the live renderer.
 */
function isSessionDropError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid session id|session deleted|closed the connection|message (to|from) renderer|chrome not reachable|disconnected|no such window|target window already closed/i.test(
    msg,
  );
}

/** Re-attach to the (possibly recycled) Capacitor WebView, forcing a fresh chromedriver session. */
async function reattachWebView(): Promise<void> {
  try {
    await browser.switchContext("NATIVE_APP");
  } catch {
    // already detached / native unavailable — the WebView switch below is what matters
  }
  await switchToWebView();
}

/**
 * Run a `browser.execute` payload, transparently recovering from a single WebView session drop by
 * re-attaching to the live renderer and retrying once. Every DOM round-trip in this module goes
 * through here so a flaky emulator CDP socket doesn't fail an otherwise-passing assertion.
 */
async function exec<T>(fn: (...a: never[]) => T, ...args: unknown[]): Promise<T> {
  try {
    return (await browser.execute(fn as never, ...(args as never[]))) as T;
  } catch (err) {
    if (!isSessionDropError(err)) {
      throw err;
    }
    await reattachWebView();
    return (await browser.execute(fn as never, ...(args as never[]))) as T;
  }
}

/** One-shot DOM probe for a selector: existence + visibility + text + aria-disabled + match count. */
async function probe(selector: string): Promise<Probe> {
  return exec((sel: string) => {
    const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const el = nodes[0] ?? null;
    if (!el) {
      return { exists: false, visible: false, text: "", ariaDisabled: null, count: 0 };
    }
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0;
    return {
      exists: true,
      visible,
      text: el.textContent ?? "",
      ariaDisabled: el.getAttribute("aria-disabled"),
      count: nodes.length,
    };
  }, selector);
}

// --- context -----------------------------------------------------------------

async function contextIds(): Promise<string[]> {
  const contexts = (await browser.getContexts()) as Array<string | { id: string }>;
  return contexts.map((c) => (typeof c === "string" ? c : c.id));
}

/** Poll `getContexts()` until the Capacitor WebView appears, then switch the driver into it. */
export async function switchToWebView(): Promise<void> {
  await browser.waitUntil(async () => (await contextIds()).includes(WEBVIEW_CONTEXT), {
    timeout: WEBVIEW_TIMEOUT,
    interval: 1_000,
    timeoutMsg: `WebView context "${WEBVIEW_CONTEXT}" never appeared`,
  });
  await browser.switchContext(WEBVIEW_CONTEXT);
}

/** Ensure the driver is attached to the WebView context (idempotent). */
export async function ensureWebView(): Promise<void> {
  const current = await browser.getContext();
  const currentId = typeof current === "string" ? current : current?.id;
  if (currentId !== WEBVIEW_CONTEXT) {
    await switchToWebView();
  }
}

// --- waits / queries ---------------------------------------------------------

/** Wait until the selector is visible (single round-trip per poll). */
export async function waitVisible(selector: string, timeout = 45_000): Promise<void> {
  await browser.waitUntil(async () => (await probe(selector)).visible, {
    timeout,
    interval: 500,
    timeoutMsg: `not visible within ${timeout}ms: ${selector}`,
  });
}

/** Wait until the testid is visible. */
export async function waitVisibleTid(t: string, timeout = 45_000): Promise<void> {
  await waitVisible(tid(t), timeout);
}

/** Assert (by waiting) that a testid is visible. Throws → fails the test if it never appears. */
export const expectVisibleTid = waitVisibleTid;

/** Wait until the testid's text contains `substring`. */
export async function expectTextTid(
  t: string,
  substring: string,
  timeout = 45_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const p = await probe(tid(t));
      return p.visible && p.text.includes(substring);
    },
    { timeout, interval: 500, timeoutMsg: `"${t}" never contained "${substring}"` },
  );
}

/** Wait until the testid's trimmed text exactly equals `value`. */
export async function expectExactTid(t: string, value: string, timeout = 20_000): Promise<void> {
  await browser.waitUntil(async () => (await probe(tid(t))).text.trim() === value, {
    timeout,
    interval: 300,
    timeoutMsg: `"${t}" never equalled "${value}"`,
  });
}

/** Wait until no element matches the testid. */
export async function expectGoneTid(t: string, timeout = 20_000): Promise<void> {
  await browser.waitUntil(async () => (await probe(tid(t))).count === 0, {
    timeout,
    interval: 300,
    timeoutMsg: `"${t}" still present after ${timeout}ms`,
  });
}

/** Number of elements matching the testid. */
export async function countTid(t: string): Promise<number> {
  return (await probe(tid(t))).count;
}

/** Whether the testid is currently visible (never throws). */
export async function isVisibleTid(t: string): Promise<boolean> {
  try {
    return (await probe(tid(t))).visible;
  } catch {
    return false;
  }
}

// --- actions -----------------------------------------------------------------

/** Click an element by selector via a JS `.click()` (after scrolling it into view). */
export async function clickSelector(selector: string): Promise<void> {
  await waitVisible(selector);
  await exec((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    el?.scrollIntoView({ block: "center" });
    el?.click();
  }, selector);
}

/** Click an element by `data-testid`. */
export async function tapTestId(t: string): Promise<void> {
  await clickSelector(tid(t));
}

/** Click the first element whose own text node contains `text` (a `getByText`-style helper). */
export async function clickByText(text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      exec((needle: string) => {
        const all = Array.from(document.querySelectorAll("span,button,ion-chip,a,p,div,h1,h2,h3"));
        const match = (all as HTMLElement[]).find((e) =>
          Array.from(e.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent ?? "").includes(needle),
          ),
        );
        if (match) {
          match.scrollIntoView({ block: "center" });
          match.click();
          return true;
        }
        return false;
      }, text),
    { timeout: 20_000, interval: 500, timeoutMsg: `no element with text "${text}"` },
  );
}

/** Type into the Ionic composer by reaching the native input inside `ion-input`'s shadow root. */
export async function fillOrder(text: string): Promise<void> {
  await waitVisibleTid("order-input", 30_000);
  await exec((value: string) => {
    const root = document.querySelector('[data-testid="order-input"]');
    const input =
      (root?.shadowRoot?.querySelector("input") as HTMLInputElement | null) ??
      (root?.querySelector("input") as HTMLInputElement | null);
    if (!input) {
      throw new Error("order-input native <input> not found");
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, text);
}

/** Wait until the composer's native input value exactly equals `value`. */
export async function expectOrderInputValue(value: string, timeout = 15_000): Promise<void> {
  await browser.waitUntil(async () => (await orderInputValue()) === value, {
    timeout,
    interval: 300,
    timeoutMsg: `order input never became "${value}"`,
  });
}

/** Read the current value of the Ionic composer's native input. */
export async function orderInputValue(): Promise<string> {
  return exec(() => {
    const root = document.querySelector('[data-testid="order-input"]');
    const input =
      (root?.shadowRoot?.querySelector("input") as HTMLInputElement | null) ??
      (root?.querySelector("input") as HTMLInputElement | null);
    return input?.value ?? "";
  });
}

// --- flow helpers ------------------------------------------------------------

/**
 * Cold-restart the app process (clean React/orchestrator state) and re-attach to its WebView.
 *
 * We deliberately AVOID an in-page reload (`window.location.assign("/")`): under Appium a full reload
 * tears down the chromedriver-attached page, after which the next command dies with
 * "invalid session id: session deleted as the browser has closed the connection". Terminating +
 * re-activating the app gives the same clean demo state (it's built with `VITE_DEMO=1`, so the default
 * route redirects `/` → `/flow`) with a fresh, healthy WebView.
 */
export async function restartApp(): Promise<void> {
  await browser.switchContext("NATIVE_APP").catch(() => undefined);
  await browser.execute("mobile: terminateApp", { appId: APP_PACKAGE });
  await browser.execute("mobile: activateApp", { appId: APP_PACKAGE });
  await switchToWebView();
}

/**
 * Ensure the test starts on a clean demo chat surface. WebdriverIO gives every spec FILE its own fresh
 * Appium session (fresh app launch), so the common case is just "attach to the WebView and wait for
 * the composer". If a previous test in the same file left us elsewhere, cold-restart the app.
 */
export async function launchFlow(): Promise<void> {
  await ensureWebView();
  try {
    await waitVisibleTid("order-input", 40_000);
  } catch {
    await restartApp();
    await waitVisibleTid("order-input", 40_000);
  }
}

/** Fill the composer, hit Send, and wait for the parsed item list to render. */
export async function sendOrder(text: string): Promise<void> {
  await fillOrder(text);
  // Wait for the send button to enable (Ionic sets aria-disabled="true" while empty/parsing).
  await browser.waitUntil(async () => (await probe(tid("send-button"))).ariaDisabled !== "true", {
    timeout: 15_000,
    interval: 300,
    timeoutMsg: "send-button stayed disabled",
  });
  await tapTestId("send-button");
  await waitVisibleTid("item-list", 30_000);
}

/** Confirm the parsed order, advancing the flow out of the chat surface. */
export async function confirmOrder(): Promise<void> {
  await tapTestId("confirm-button");
}

/** Wait for the Comparison/approval screen (after demo quoting + optimize). */
export async function expectComparison(): Promise<void> {
  await waitVisibleTid("allocation-card", 60_000);
  await waitVisibleTid("proceed-button", 60_000);
}

export { browser, $$, expect };

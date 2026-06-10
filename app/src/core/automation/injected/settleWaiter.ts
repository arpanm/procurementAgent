/**
 * Page-settle / network-idle detection (PROCURE_COPILOT_PLAN.md §3.5.5).
 *
 * `buildSettleScript` is the injectable IIFE string: it patches `fetch`, watches DOM mutations, and
 * resolves once both have been quiet for a debounce window — with an 8s hard cap. `createSettleWaiter`
 * is the same debounce/idle state machine extracted as a pure, timer-injectable helper so it can be
 * unit-tested without a real webview.
 */
import { encodeScriptMeta } from "./scriptProtocol";
import { bridgeEmitFnSource } from "./bridgeEmit";

const DEFAULT_DEBOUNCE_MS = 600;
const DEFAULT_HARD_CAP_MS = 8000;

export interface SettleWaiterHandle {
  /** Signal DOM/network activity; (re)starts the debounce window. */
  bump(): void;
  /** Mark a request as in-flight. */
  incInflight(): void;
  /** Mark a request as completed. */
  decInflight(): void;
  /** Cancel all timers without firing `onReady`. */
  dispose(): void;
}

export interface SettleWaiterOptions {
  readonly debounceMs?: number;
  readonly hardCapMs?: number;
  /** Injectable timers for deterministic tests; default to globals. */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Resolves `onReady` exactly once, when no activity has occurred for `debounceMs` and no requests are
 * in flight — or unconditionally after `hardCapMs`.
 */
export function createSettleWaiter(
  onReady: () => void,
  opts: SettleWaiterOptions = {},
): SettleWaiterHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const hardCapMs = opts.hardCapMs ?? DEFAULT_HARD_CAP_MS;
  const setTimeoutFn =
    opts.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let inflight = 0;
  let debounceTimer: unknown = null;
  let capTimer: unknown = null;
  let done = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    if (debounceTimer != null) clearTimeoutFn(debounceTimer);
    if (capTimer != null) clearTimeoutFn(capTimer);
    onReady();
  };

  const bump = (): void => {
    if (done) return;
    if (debounceTimer != null) clearTimeoutFn(debounceTimer);
    debounceTimer = setTimeoutFn(() => {
      if (inflight === 0) finish();
    }, debounceMs);
  };

  capTimer = setTimeoutFn(finish, hardCapMs);

  return {
    bump,
    incInflight(): void {
      inflight++;
      bump();
    },
    decInflight(): void {
      inflight = Math.max(0, inflight - 1);
      bump();
    },
    dispose(): void {
      done = true;
      if (debounceTimer != null) clearTimeoutFn(debounceTimer);
      if (capTimer != null) clearTimeoutFn(capTimer);
    },
  };
}

/**
 * The injectable settle-waiter string posted back over the Capgo bridge as `{ type: 'ready' }`. Never
 * executed in tests (the MockBridge resolves settle synchronously off the encoded metadata header).
 */
export function buildSettleScript(requestId: string): string {
  const meta = encodeScriptMeta({ kind: "settle", requestId });
  return `${meta}
(function () {
  ${bridgeEmitFnSource()}
  var RID = ${JSON.stringify(requestId)};
  try { console.log('[hpinj] settle start rid=' + RID + ' mobileApp=' + (typeof (window.mobileApp))); } catch (e) {}
  var inflight = 0, timer = null, done = false;
  function finish() {
    if (done) return; done = true;
    try { console.log('[hpinj] settle finish rid=' + RID + ' inflight=' + inflight); } catch (e) {}
    __hpEmit(RID, { requestId: RID, type: 'ready' });
  }
  function bump() {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { if (inflight === 0) finish(); }, ${DEFAULT_DEBOUNCE_MS});
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      inflight++; bump();
      return origFetch.apply(this, arguments).finally(function () { inflight--; bump(); });
    };
  }
  // Many SPAs (Hyperpure/Zomato use axios) load their product grid over XMLHttpRequest, not fetch.
  // Without tracking XHR, settle fires on the bare shell BEFORE the priced tiles render, so perceive
  // sees only the sidebar. Track XHR inflight so we wait for the listing's data call + React render.
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && XHR.prototype.send) {
      var origSend = XHR.prototype.send;
      XHR.prototype.send = function () {
        var self = this, settled = false;
        var fin = function () { if (settled) return; settled = true; inflight--; bump(); };
        try { inflight++; bump(); self.addEventListener('loadend', fin); }
        catch (e) { fin(); }
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}
  try {
    new MutationObserver(bump).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setTimeout(finish, ${DEFAULT_HARD_CAP_MS});
  bump();
})();`;
}

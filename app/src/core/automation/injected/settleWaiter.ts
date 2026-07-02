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

  // Shared document-level state, installed ONCE. Re-injecting this script every perceive/settle cycle
  // previously re-wrapped window.fetch / XHR.send and added a fresh MutationObserver each time, stacking
  // wrappers and leaking observers over a long run. Now fetch/XHR/observer are patched a single time and
  // drive a shared inflight counter + a list of per-call bump listeners; each settle registers its bump
  // and removes it on finish.
  var G = window.__hpSettle;
  if (!G) {
    G = window.__hpSettle = { inflight: 0, bumps: [] };
    G.fire = function () {
      var list = G.bumps.slice();
      for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) {} }
    };
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function () {
        G.inflight++; G.fire();
        return origFetch.apply(this, arguments).finally(function () { G.inflight--; G.fire(); });
      };
    }
    // Many SPAs (Hyperpure/Zomato use axios) load their product grid over XMLHttpRequest, not fetch.
    // Track XHR inflight so settle waits for the listing's data call + React render, not just the shell.
    try {
      var XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype && XHR.prototype.send) {
        var origSend = XHR.prototype.send;
        XHR.prototype.send = function () {
          var self = this, settled = false;
          var fin = function () { if (settled) return; settled = true; G.inflight--; G.fire(); };
          try { G.inflight++; G.fire(); self.addEventListener('loadend', fin); }
          catch (e) { fin(); }
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      new MutationObserver(G.fire).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  var timer = null, done = false;
  function unregister() {
    var i = G.bumps.indexOf(bump);
    if (i >= 0) G.bumps.splice(i, 1);
  }
  function finish() {
    if (done) return; done = true;
    unregister();
    try { console.log('[hpinj] settle finish rid=' + RID + ' inflight=' + G.inflight); } catch (e) {}
    __hpEmit(RID, { requestId: RID, type: 'ready' });
  }
  function bump() {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { if (G.inflight === 0) finish(); }, ${DEFAULT_DEBOUNCE_MS});
  }
  G.bumps.push(bump);
  setTimeout(finish, ${DEFAULT_HARD_CAP_MS});
  bump();
})();`;
}

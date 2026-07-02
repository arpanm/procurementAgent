/**
 * The bridge seam (PROCURE_COPILOT_PLAN.md §3.6.2, §3.6.3).
 *
 * `InAppBrowserBridge` abstracts the Capgo `@capgo/capacitor-inappbrowser` plugin so the engine never
 * speaks the raw plugin. `AbstractBridge` implements the `requestId`-correlated `call()` that turns the
 * fire-and-forget message channel into awaitable promises, plus listener fan-out for unsolicited
 * events. `CapgoBridge` wires it to the real plugin; `MockBridge` (separate file) drives a jsdom doc.
 */
import { InAppBrowser, ToolBarType } from "@capgo/capacitor-inappbrowser";
import type { InAppBrowserPlugin } from "@capgo/capacitor-inappbrowser";
import { isAutomationDebug, traceAutomation } from "../debug/automationDebug";
import {
  BRIDGE_CONSOLE_PREFIX,
  BRIDGE_CONSOLE_SUFFIX,
  bridgeEmitFnSource,
} from "./injected/bridgeEmit";

/**
 * High-volume page-console noise that buries the real automation signal in the debug trace. These are
 * site-internal logs (Hyperpure's rail logger, Datadog SDK, mixed-content image blocks) irrelevant to
 * our bridge/automation diagnostics.
 */
const CONSOLE_NOISE_RE =
  /hp-web-service|Datadog Browser SDK|Mixed Content|RUM data will be collected|Refused to set unsafe header/i;

/** Split `s` on `sep` into at most `max` parts; the final part keeps any remaining separators. */
function splitN(s: string, sep: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (out.length < max - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

/** Detail bag delivered over the message channel; matched to a pending `call` by `requestId`. */
export type BridgeMessageListener = (
  detail: Record<string, unknown>,
  id?: string,
) => void;

export type BridgeUrlChangeListener = (url: string, id?: string) => void;

export interface InAppBrowserBridge {
  open(id: string, url: string, hidden: boolean): Promise<void>;
  executeScript(id: string, code: string): Promise<void>;
  postMessage(id: string, detail: Record<string, unknown>): Promise<void>;
  /** Subscribe to unsolicited messages (not matched to a pending call). Returns an unsubscribe fn. */
  addMessageListener(cb: BridgeMessageListener): () => void;
  /** Subscribe to navigation events (used for OTP/payment redirect detection). */
  addUrlChangeListener(cb: BridgeUrlChangeListener): () => void;
  show(id: string): Promise<void>;
  hide(id: string): Promise<void>;
  close(id: string): Promise<void>;
  /** Capture a screenshot; resolves to a data URL (used for failure eval, §3.5.10). */
  screenshot(id: string): Promise<string>;
  /**
   * Inject `codeFactory(requestId)` and resolve with the correlated `{ requestId, ... }` reply
   * the injected script posts back (§3.6.3).
   */
  call(
    id: string,
    codeFactory: (requestId: string) => string,
    opts?: { mutating?: boolean },
  ): Promise<Record<string, unknown>>;

  /**
   * Open the platform webview VISIBLY with a navigation toolbar for a manual sign-in / set-location
   * hand-off, and resolve when the user closes the window (so the caller can then scrape an
   * authenticated session — cookies persist in the shared WebView store). Optional: only the real
   * Capgo bridge implements it; mocks/tests omit it.
   */
  openLoginSession?(id: string, url: string): Promise<void>;
}

/**
 * Normalise the inbound `messageFromWebview` payload to the flat `{ requestId, ... }` the bridge
 * correlates on. The Capgo plugin delivers the object the page passed to `window.mobileApp.postMessage`
 * as `event.detail`, so the injected scripts post a flat object. We also tolerate a legacy double-wrap
 * (`{ detail: { requestId, ... } }`) and a `rawMessage` JSON string, so a plugin-version mismatch
 * can't silently strand every `call()` at the 15s timeout again.
 */
function normalizeInboundDetail(event: {
  detail?: Record<string, unknown>;
  rawMessage?: string;
}): Record<string, unknown> {
  let detail = (event.detail ?? {}) as Record<string, unknown>;
  if (
    detail.requestId === undefined &&
    detail.detail &&
    typeof detail.detail === "object"
  ) {
    detail = detail.detail as Record<string, unknown>;
  }
  if (detail.requestId === undefined && typeof event.rawMessage === "string") {
    try {
      const parsed = JSON.parse(event.rawMessage) as Record<string, unknown>;
      detail =
        parsed.detail && typeof parsed.detail === "object"
          ? (parsed.detail as Record<string, unknown>)
          : parsed;
    } catch {
      /* not JSON — leave detail as-is */
    }
  }
  return detail;
}

/** Safety backstop for a login window whose close event is missed (15 min — far beyond any real sign-in). */
const LOGIN_SESSION_MAX_WAIT_MS = 15 * 60 * 1000;

function randomRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `rid-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Shared bridge plumbing: a single `requestId`→Promise correlation map, listener registries, and the
 * `call()` helper. Subclasses implement the transport (real plugin vs. in-process mock) and feed
 * inbound traffic in via `emitMessage` / `emitUrlChange`.
 */
export abstract class AbstractBridge implements InAppBrowserBridge {
  private readonly pending = new Map<
    string,
    (detail: Record<string, unknown>) => void
  >();
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Per-in-flight-call metadata for re-injection. A page can navigate/reload mid-call (e.g. Hyperpure's
   * hydration + location redirect), which destroys the injected script's context so it can never reply.
   * On `browserPageLoaded`, `reinjectPending` re-runs the script in the fresh page using this.
   */
  private readonly pendingMeta = new Map<
    string,
    {
      id: string;
      codeFactory: (requestId: string) => string;
      reinjects: number;
      /** Mutating actions (click/type/select) must NOT be blindly re-injected — see reinjectPending. */
      mutating: boolean;
    }
  >();
  private readonly messageListeners = new Set<BridgeMessageListener>();
  private readonly urlListeners = new Set<BridgeUrlChangeListener>();

  /** Max time to wait for a correlated reply before rejecting the call. */
  protected callTimeoutMs = 15000;
  /** Cap on re-injections per call, so a reload-looping page can't inject forever. */
  protected maxReinjects = 4;

  abstract open(id: string, url: string, hidden: boolean): Promise<void>;
  abstract executeScript(id: string, code: string): Promise<void>;
  abstract postMessage(id: string, detail: Record<string, unknown>): Promise<void>;
  abstract show(id: string): Promise<void>;
  abstract hide(id: string): Promise<void>;
  abstract close(id: string): Promise<void>;
  abstract screenshot(id: string): Promise<string>;

  addMessageListener(cb: BridgeMessageListener): () => void {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  addUrlChangeListener(cb: BridgeUrlChangeListener): () => void {
    this.urlListeners.add(cb);
    return () => {
      this.urlListeners.delete(cb);
    };
  }

  /** Route an inbound message: resolve a pending call if `requestId` matches, else fan out (§3.6.3). */
  protected emitMessage(detail: Record<string, unknown>, id?: string): void {
    const rid = typeof detail.requestId === "string" ? detail.requestId : undefined;
    if (rid && this.pending.has(rid)) {
      const resolve = this.pending.get(rid);
      this.pending.delete(rid);
      this.pendingMeta.delete(rid);
      const timer = this.pendingTimers.get(rid);
      if (timer) clearTimeout(timer);
      this.pendingTimers.delete(rid);
      this.releaseCall(rid);
      if (resolve) resolve(detail);
      return;
    }
    for (const listener of this.messageListeners) listener(detail, id);
  }

  /**
   * Re-inject every in-flight IDEMPOTENT call targeting `logicalId` into the (just-loaded) page. Called
   * when the webview fires a page-load event, so a navigation that wiped our injected scripts mid-call
   * doesn't strand the `call()` at its timeout. Idempotent reads (settle/perceive) re-run harmlessly.
   *
   * MUTATING calls (click/type/select) are deliberately SKIPPED: re-dispatching a click after a mid-action
   * reload could apply it twice (e.g. add the same item to the cart twice). Such a call is left to time out
   * and be retried by the higher-level, effect-verifying logic instead.
   */
  protected reinjectPending(
    logicalId: string,
    onReinject?: (rid: string, attempt: number) => void,
  ): void {
    for (const [rid, meta] of this.pendingMeta) {
      if (meta.id !== logicalId) continue;
      if (meta.mutating) continue;
      if (meta.reinjects >= this.maxReinjects) continue;
      meta.reinjects += 1;
      onReinject?.(rid, meta.reinjects);
      void this.executeScript(meta.id, meta.codeFactory(rid)).catch(() => {
        /* best-effort: the call's own timeout still governs final failure */
      });
    }
  }

  /** Hook: a call has settled (resolved/timed out/errored). Subclasses release any per-rid transport state. */
  protected releaseCall(_rid: string): void {
    /* default no-op; CapgoBridge drops its chunk-reassembly buffer */
  }

  protected emitUrlChange(url: string, id?: string): void {
    for (const listener of this.urlListeners) listener(url, id);
  }

  call(
    id: string,
    codeFactory: (requestId: string) => string,
    opts?: { mutating?: boolean },
  ): Promise<Record<string, unknown>> {
    const rid = randomRequestId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(rid, resolve);
      this.pendingMeta.set(rid, { id, codeFactory, reinjects: 0, mutating: opts?.mutating ?? false });
      const timer = setTimeout(() => {
        if (this.pending.has(rid)) {
          this.pending.delete(rid);
          this.pendingMeta.delete(rid);
          this.pendingTimers.delete(rid);
          this.releaseCall(rid);
          reject(new Error(`Bridge call timed out after ${this.callTimeoutMs}ms`));
        }
      }, this.callTimeoutMs);
      this.pendingTimers.set(rid, timer);
      this.executeScript(id, codeFactory(rid)).catch((err: unknown) => {
        if (this.pending.has(rid)) {
          this.pending.delete(rid);
          this.pendingMeta.delete(rid);
          clearTimeout(timer);
          this.pendingTimers.delete(rid);
          this.releaseCall(rid);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }
}

/**
 * Production bridge over the Capgo plugin. Capgo assigns its own webview ids, so we keep a logical
 * id → plugin id map (best-effort mapping per the plan's "keep it behind the interface").
 */
export class CapgoBridge extends AbstractBridge {
  private readonly idMap = new Map<string, string>();
  /** In-flight reassembly buffers for the chunked console reply transport, keyed by requestId. */
  private readonly bridgeChunks = new Map<
    string,
    { total: number; parts: Map<number, string>; createdAt: number }
  >();
  /** Drop a partial reassembly older than this (a reply whose remaining chunks never arrived). */
  private static readonly CHUNK_TTL_MS = 20000;
  /** Hard cap on concurrent partial reassemblies, so a misbehaving page can't grow the map unbounded. */
  private static readonly MAX_CHUNK_ENTRIES = 64;

  /** Release a settled call's partial reassembly buffer (M7): no more chunks will arrive for it. */
  protected override releaseCall(rid: string): void {
    this.bridgeChunks.delete(rid);
  }

  /** Evict stale (never-completed) and, if over cap, the oldest partial reassemblies. */
  private pruneChunkBuffers(now: number): void {
    for (const [rid, entry] of this.bridgeChunks) {
      if (now - entry.createdAt > CapgoBridge.CHUNK_TTL_MS) this.bridgeChunks.delete(rid);
    }
    if (this.bridgeChunks.size > CapgoBridge.MAX_CHUNK_ENTRIES) {
      const oldestFirst = [...this.bridgeChunks.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      );
      for (const [rid] of oldestFirst.slice(0, this.bridgeChunks.size - CapgoBridge.MAX_CHUNK_ENTRIES)) {
        this.bridgeChunks.delete(rid);
      }
    }
  }

  constructor(private readonly plugin: InAppBrowserPlugin = InAppBrowser) {
    super();
    void this.plugin.addListener("messageFromWebview", (event) => {
      this.emitMessage(normalizeInboundDetail(event), event.id);
    });
    // Confirms the full JS→native message path works end-to-end (the probe posts `__probe__`).
    this.addMessageListener((detail) => {
      if (detail && detail.requestId === "__probe__") {
        traceAutomation("info", "probe round-trip OK — messageFromWebview delivery works");
      }
    });
    void this.plugin.addListener("urlChangeEvent", (event) => {
      this.emitUrlChange(event.url, event.id);
    });
    // Page-load diagnostics (debug trace only): distinguishes "blank render" from a real load error.
    void this.plugin.addListener("browserPageLoaded", (event) => {
      const logical = this.logicalIdFor(event.id);
      traceAutomation("info", "page loaded", logical);
      // A navigation/reload after we injected a call's script destroys its context (e.g. Hyperpure's
      // post-load redirect). Re-inject any in-flight call so it can reply from the fresh page.
      if (logical) {
        this.reinjectPending(logical, (rid, attempt) => {
          traceAutomation("info", `re-inject after load (attempt ${attempt}) rid=${rid}`, logical);
        });
      }
    });
    void this.plugin.addListener("pageLoadError", (event) => {
      traceAutomation("error", "page load error (blocked / blank)", this.logicalIdFor(event.id));
    });
    // Page console → (a) primary inbound transport for injected-script replies (chunked, prefixed),
    // and (b) debug trace of page warnings/errors + our `[probe]` diagnostics.
    void this.plugin.addListener("consoleMessage", (event) => {
      const raw = event.message ?? "";
      // (a) Inbound transport: a reply chunk may appear anywhere in the line (a page can wrap console).
      if (raw.indexOf(BRIDGE_CONSOLE_PREFIX) >= 0 && raw.indexOf(BRIDGE_CONSOLE_SUFFIX) >= 0) {
        this.handleBridgeChunk(raw, event.id);
        return;
      }
      // (b) Our injected-script diagnostics always surface.
      if (raw.includes("[hpinj]") || raw.includes("[probe]")) {
        traceAutomation("info", raw.slice(0, 200), this.logicalIdFor(event.id));
        return;
      }
      // (c) Page warnings/errors — minus the known high-volume noise that buries the real signal.
      if (event.level !== "warn" && event.level !== "error") {
        return;
      }
      if (CONSOLE_NOISE_RE.test(raw)) {
        return;
      }
      const level = event.level === "error" ? "error" : "warn";
      traceAutomation(level, `page console: ${raw.slice(0, 220)}`, this.logicalIdFor(event.id));
    });
  }

  /**
   * Reassemble a chunked `@@HPB@@<rid>@@<seq>@@<total>@@<json>@@HPE@@` console reply and route it
   * inward. Tolerant to the page wrapping console output (prefix/suffix located by sentinel search).
   */
  private handleBridgeChunk(message: string, eventId?: string): void {
    const start = message.indexOf(BRIDGE_CONSOLE_PREFIX);
    const end = message.indexOf(BRIDGE_CONSOLE_SUFFIX, start + BRIDGE_CONSOLE_PREFIX.length);
    if (start < 0 || end < 0) return;
    const body = message.slice(start + BRIDGE_CONSOLE_PREFIX.length, end);
    const parts = splitN(body, "@@", 4);
    if (parts.length < 4) return;
    const [rid, seqStr, totalStr, chunk] = parts;
    const seq = Number.parseInt(seqStr, 10);
    const total = Number.parseInt(totalStr, 10);
    if (!Number.isFinite(seq) || !Number.isFinite(total) || total < 1) return;

    const now = Date.now();
    let entry = this.bridgeChunks.get(rid);
    if (!entry) {
      this.pruneChunkBuffers(now);
      entry = { total, parts: new Map<number, string>(), createdAt: now };
      this.bridgeChunks.set(rid, entry);
    }
    entry.parts.set(seq, chunk);
    if (entry.parts.size < entry.total) return;

    this.bridgeChunks.delete(rid);
    let full = "";
    for (let k = 0; k < entry.total; k++) full += entry.parts.get(k) ?? "";
    try {
      const obj = JSON.parse(full) as Record<string, unknown>;
      traceAutomation(
        "info",
        `bridge reply in: type=${String(obj.type)} rid=${rid}`,
        this.logicalIdFor(eventId),
      );
      this.emitMessage(obj, undefined);
    } catch (err) {
      traceAutomation(
        "error",
        `bridge reply parse failed (rid=${rid}, len=${full.length}): ${err instanceof Error ? err.message : String(err)}`,
        this.logicalIdFor(eventId),
      );
    }
  }

  /**
   * openWebView options. `captureConsoleLogs` is ALWAYS on because the console channel is our primary
   * JS→native reply transport (the `messageFromWebview` channel is unreliable on this plugin build).
   * `isInspectable` (chrome://inspect) is enabled only in automation-debug mode.
   */
  private openOptions(): { captureConsoleLogs: boolean; isInspectable?: boolean } {
    return isAutomationDebug()
      ? { captureConsoleLogs: true, isInspectable: true }
      : { captureConsoleLogs: true };
  }

  /**
   * Inject a one-shot probe that reports (via the page console) whether `window.mobileApp` — the
   * plugin's JS→native bridge our injected scripts rely on — is actually present, and whether a test
   * postMessage round-trips. Captured by the `consoleMessage` listener above. Debug-only.
   */
  private async injectProbe(id: string): Promise<void> {
    // Exercise BOTH inbound transports with a tiny payload, isolated from any heavy page activity:
    //   - `__hpEmit` (chunked console)  → resolves the `__probe__` call if the console channel works.
    //   - `window.mobileApp.postMessage` → resolves it if the messageFromWebview channel works.
    // The bridge logs `bridge reply in: type=probe rid=__probe__` for whichever arrives.
    const code =
      `(function(){${bridgeEmitFnSource()}try{var m=window.mobileApp;` +
      `console.log('[probe] mobileApp='+(typeof m)+' postMessage='+(m&&typeof m.postMessage));` +
      `__hpEmit('__probe__',{requestId:'__probe__',type:'probe'});` +
      `console.log('[probe] __hpEmit sent');` +
      `if(m&&typeof m.postMessage==='function'){m.postMessage({requestId:'__probe__',type:'probe'});` +
      `console.log('[probe] postMessage sent');}else{console.error('[probe] window.mobileApp.postMessage is NOT available');}` +
      `}catch(e){console.error('[probe] threw: '+(e&&e.message?e.message:e));}})();`;
    try {
      await this.executeScript(id, code);
    } catch (err) {
      traceAutomation(
        "warn",
        `probe injection failed: ${err instanceof Error ? err.message : String(err)}`,
        this.logicalIdFor(this.idMap.get(id)),
      );
    }
  }

  private pid(id: string): string {
    return this.idMap.get(id) ?? id;
  }

  /** Reverse-map a plugin webview id back to our logical platform id, for readable trace lines. */
  private logicalIdFor(pluginId?: string): string | undefined {
    if (!pluginId) return undefined;
    for (const [logical, pid] of this.idMap) {
      if (pid === pluginId) return logical;
    }
    return undefined;
  }

  async open(id: string, url: string, hidden: boolean): Promise<void> {
    // Always open a FRESH native webview so the page fires `browserPageLoaded` → our `reinjectPending`
    // safety net runs. A `setUrl` navigation on a reused webview does NOT reliably emit that event, so a
    // settle/perceive call whose script context the navigation wiped never gets re-injected and strands
    // at the 15s timeout — the "open/login failed: Bridge call timed out" regression. To still avoid the
    // "multiple Hyperpure screens, none closing" stacking bug, close any existing webview for this
    // logical id first (cookies/session live in the shared WebView store, so auth survives the reopen).
    const existing = this.idMap.get(id);
    if (existing) {
      try {
        await this.plugin.close({ id: existing });
      } catch (err) {
        traceAutomation(
          "warn",
          `close-before-reopen failed (${err instanceof Error ? err.message : String(err)}); the old webview may already be gone`,
          this.logicalIdFor(existing),
        );
      }
      this.idMap.delete(id);
    }
    const res = await this.plugin.openWebView({ url, hidden, ...this.openOptions() });
    if (res && typeof res.id === "string") this.idMap.set(id, res.id);
    if (isAutomationDebug()) {
      await this.injectProbe(id);
    }
  }

  async executeScript(id: string, code: string): Promise<void> {
    await this.plugin.executeScript({ id: this.pid(id), code });
  }

  async postMessage(id: string, detail: Record<string, unknown>): Promise<void> {
    await this.plugin.postMessage({ id: this.pid(id), detail });
  }

  async show(id: string): Promise<void> {
    await this.plugin.show({ id: this.pid(id) });
  }

  async hide(id: string): Promise<void> {
    await this.plugin.hide({ id: this.pid(id) });
  }

  async close(id: string): Promise<void> {
    await this.plugin.close({ id: this.pid(id) });
    this.idMap.delete(id);
  }

  async screenshot(id: string): Promise<string> {
    const shot = await this.plugin.takeScreenshot({ id: this.pid(id) });
    return shot.dataUrl;
  }

  /**
   * Open visibly with a navigation toolbar for the user to sign in / set their delivery location,
   * then resolve once they close the window. The session's cookies persist in the shared Android
   * WebView store, so the subsequent (hidden or visible) scrape runs authenticated.
   */
  async openLoginSession(id: string, url: string): Promise<void> {
    await new Promise<void>((resolve) => {
      let handle: { remove: () => Promise<void> } | undefined;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.idMap.delete(id);
        if (timer) clearTimeout(timer);
        void handle?.remove();
        resolve();
      };
      // Register the close listener BEFORE opening the window, so a very fast close can't fire in the gap
      // between openWebView resolving and addListener completing (which would strand this promise).
      void this.plugin
        .addListener("closeEvent", finish)
        .then((h) => {
          handle = h;
          if (done) void h.remove();
        });
      void this.plugin
        .openWebView({ url, toolbarType: ToolBarType.NAVIGATION, ...this.openOptions() })
        .then((res) => {
          if (res && typeof res.id === "string") this.idMap.set(id, res.id);
        })
        .catch(() => finish());
      // Safety backstop: never hang forever if the close event is somehow missed.
      timer = setTimeout(finish, LOGIN_SESSION_MAX_WAIT_MS);
    });
  }
}

/**
 * In-process test/preview bridge (PROCURE_COPILOT_PLAN.md §3.5, §3.6.3).
 *
 * Instead of injecting JS into a device webview, it runs the *pure* perceiver/actor functions against
 * a real jsdom `Document` and delivers the results over the same message channel the engine expects.
 * This lets `WebViewAutomationEngine` be exercised end-to-end with zero device dependency. The script
 * the engine "injects" carries an encoded metadata header (see scriptProtocol) that tells the mock
 * which pure function to run.
 */
import { AbstractBridge } from "./bridge";
import { serializeDom } from "./injected/domSerializer";
import { executeAction } from "./injected/actionExecutor";
import { decodeScriptMeta } from "./injected/scriptProtocol";

export interface MockBridgeOptions {
  /** Document the mock perceives/acts on. Defaults to the ambient jsdom `document`. */
  readonly doc?: Document;
}

export class MockBridge extends AbstractBridge {
  private readonly doc: Document;
  private readonly win: Window;

  /** Inspection hooks for tests. */
  readonly opened: { id: string; url: string; hidden: boolean }[] = [];
  readonly shownIds: string[] = [];
  readonly hiddenIds: string[] = [];
  readonly closedIds: string[] = [];
  screenshotCount = 0;

  constructor(opts: MockBridgeOptions = {}) {
    super();
    const doc = opts.doc ?? document;
    this.doc = doc;
    this.win = (doc.defaultView ?? window) as Window;
  }

  async open(id: string, url: string, hidden: boolean): Promise<void> {
    this.opened.push({ id, url, hidden });
  }

  async executeScript(id: string, code: string): Promise<void> {
    const meta = decodeScriptMeta(code);
    if (!meta) return;
    if (meta.kind === "dom") {
      const observation = serializeDom(this.doc, this.win);
      this.emitMessage(
        { requestId: meta.requestId, type: "dom", ...observation },
        id,
      );
    } else if (meta.kind === "settle") {
      this.emitMessage({ requestId: meta.requestId, type: "ready" }, id);
    } else {
      const result = executeAction(this.doc, meta.action);
      this.emitMessage(
        {
          requestId: meta.requestId,
          type: "action",
          ok: result.ok,
          reason: result.reason ?? null,
        },
        id,
      );
    }
  }

  async postMessage(_id: string, _detail: Record<string, unknown>): Promise<void> {
    /* no-op for the mock */
  }

  async show(id: string): Promise<void> {
    this.shownIds.push(id);
  }

  async hide(id: string): Promise<void> {
    this.hiddenIds.push(id);
  }

  async close(id: string): Promise<void> {
    this.closedIds.push(id);
  }

  async screenshot(_id: string): Promise<string> {
    this.screenshotCount++;
    return "data:image/png;base64,MOCK";
  }

  /** Test helper: simulate a navigation so OTP/payment URL detection fires (§3.5.9). */
  simulateUrlChange(url: string, id?: string): void {
    this.emitUrlChange(url, id);
  }
}

import { describe, expect, it, vi } from "vitest";
import { CapgoBridge } from "./bridge";
import { BRIDGE_CONSOLE_PREFIX, BRIDGE_CONSOLE_SUFFIX } from "./injected/bridgeEmit";

type Listener = (event: Record<string, unknown>) => void;

/**
 * Minimal fake of the Capgo plugin that lets a test drive the `consoleMessage` channel — the real
 * JS→native reply transport on device. Verifies the chunk reassembly that kept stranding `call()`s.
 */
function makeFakePlugin(): {
  plugin: NonNullable<ConstructorParameters<typeof CapgoBridge>[0]>;
  fire: (eventName: string, event: Record<string, unknown>) => void;
} {
  const listeners = new Map<string, Listener>();
  const plugin = {
    addListener: (name: string, cb: Listener) => {
      listeners.set(name, cb);
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
    openWebView: vi.fn(async () => ({ id: "pid-1" })),
    executeScript: vi.fn(async () => undefined),
    postMessage: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    takeScreenshot: vi.fn(async () => ({ dataUrl: "" })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return {
    plugin,
    fire: (eventName, event) => listeners.get(eventName)?.(event),
  };
}

function frame(rid: string, seq: number, total: number, chunk: string): string {
  return `${BRIDGE_CONSOLE_PREFIX}${rid}@@${seq}@@${total}@@${chunk}${BRIDGE_CONSOLE_SUFFIX}`;
}

async function startCall(
  bridge: CapgoBridge,
): Promise<{ promise: Promise<Record<string, unknown>>; rid: string }> {
  await bridge.open("amazon", "https://example.test", true);
  // Ignore any open-time injection (e.g. the debug probe) so callers can reason about call/re-inject.
  (
    bridge as unknown as { plugin: { executeScript: ReturnType<typeof vi.fn> } }
  ).plugin.executeScript.mockClear();
  let rid = "";
  const promise = bridge.call("amazon", (r) => {
    rid = r;
    return `/* injected ${r} */`;
  });
  return { promise, rid };
}

describe("CapgoBridge console transport", () => {
  it("reassembles a single-chunk reply and resolves the correlated call", async () => {
    const { plugin, fire } = makeFakePlugin();
    const bridge = new CapgoBridge(plugin);
    const { promise, rid } = await startCall(bridge);

    const json = JSON.stringify({ requestId: rid, type: "ready" });
    fire("consoleMessage", { message: frame(rid, 0, 1, json), id: "pid-1", level: "log" });

    await expect(promise).resolves.toMatchObject({ requestId: rid, type: "ready" });
  });

  it("reassembles a multi-chunk reply across console lines", async () => {
    const { plugin, fire } = makeFakePlugin();
    const bridge = new CapgoBridge(plugin);
    const { promise, rid } = await startCall(bridge);

    const json = JSON.stringify({ requestId: rid, type: "perceive", elements: ["a", "b"] });
    const mid = Math.ceil(json.length / 2);
    fire("consoleMessage", { message: frame(rid, 0, 2, json.slice(0, mid)), id: "pid-1", level: "log" });
    fire("consoleMessage", { message: frame(rid, 1, 2, json.slice(mid)), id: "pid-1", level: "log" });

    await expect(promise).resolves.toMatchObject({ type: "perceive", elements: ["a", "b"] });
  });

  it("re-injects an in-flight call after a page reload, then resolves it", async () => {
    const { plugin, fire } = makeFakePlugin();
    const bridge = new CapgoBridge(plugin);
    const { promise, rid } = await startCall(bridge);

    // The page navigates/reloads, destroying the first injected script before it can reply.
    fire("browserPageLoaded", { id: "pid-1" });

    // executeScript called twice for the same rid: original inject + re-inject after reload.
    const execCalls = (plugin.executeScript as ReturnType<typeof vi.fn>).mock.calls;
    expect(execCalls.length).toBe(2);
    expect(execCalls[0][0]).toMatchObject({ code: expect.stringContaining(rid) });
    expect(execCalls[1][0]).toMatchObject({ code: expect.stringContaining(rid) });

    // The re-injected script (in the fresh page) finally replies.
    const json = JSON.stringify({ requestId: rid, type: "ready" });
    fire("consoleMessage", { message: frame(rid, 0, 1, json), id: "pid-1", level: "log" });
    await expect(promise).resolves.toMatchObject({ type: "ready" });
  });

  it("tolerates a page wrapping console output around the sentinels", async () => {
    const { plugin, fire } = makeFakePlugin();
    const bridge = new CapgoBridge(plugin);
    const { promise, rid } = await startCall(bridge);

    const json = JSON.stringify({ requestId: rid, type: "ready" });
    const wrapped = `[hp-web-service] LOG ${frame(rid, 0, 1, json)} <-- emitted`;
    fire("consoleMessage", { message: wrapped, id: "pid-1", level: "log" });

    await expect(promise).resolves.toMatchObject({ type: "ready" });
  });
});

/**
 * Opt-in automation debug tracer.
 *
 * Turned on ONLY by an explicit dev signal (never on in the checked-in build):
 *   - env flag `VITE_DEBUG_AUTOMATION=1` (set it in `app/.env` for a device build), or
 *   - `?debugAuto=1` on the URL (handy in a browser).
 *
 * When on, the automation engine and flow controller emit a running "what am I doing" trace
 * (perceive → plan → act → verify → Claude fallback → fail) plus errors. Each entry is mirrored to
 * the JS console (so it lands in `adb logcat`) AND pushed to a tiny subscribable store that the
 * on-screen {@link AutomationDebugOverlay} renders live, like a thinking-model stream. When off,
 * every `traceAutomation` call is a cheap no-op.
 */

export type AutomationTraceLevel = "think" | "info" | "warn" | "error";

export interface AutomationTraceEntry {
  readonly id: number;
  /** epoch ms */
  readonly at: number;
  readonly level: AutomationTraceLevel;
  readonly platform?: string;
  readonly message: string;
}

let cachedEnabled: boolean | null = null;

/** Whether automation debug mode is active (memoised after first read). */
export function isAutomationDebug(): boolean {
  if (cachedEnabled !== null) {
    return cachedEnabled;
  }
  let on = false;
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("debugAuto") === "1") {
        on = true;
      }
    }
  } catch {
    // No DOM (tests/SSR) — fall through to the env flag.
  }
  if (!on) {
    const env =
      (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    on = env.VITE_DEBUG_AUTOMATION === "1";
  }
  cachedEnabled = on;
  return on;
}

/** Test-only: force the flag (so unit tests can exercise both states deterministically). */
export function __setAutomationDebugForTests(value: boolean | null): void {
  cachedEnabled = value;
}

const MAX_ENTRIES = 2000;
const entries: AutomationTraceEntry[] = [];
const listeners = new Set<() => void>();
let seq = 0;

/** Record a trace line (no-op unless debug is enabled). */
export function traceAutomation(
  level: AutomationTraceLevel,
  message: string,
  platform?: string,
): void {
  if (!isAutomationDebug()) {
    return;
  }
  seq += 1;
  entries.push({ id: seq, at: Date.now(), level, message, platform });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  const tag = platform ? `[auto:${platform}]` : "[auto]";
  const line = `${tag} ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe to trace changes (for `useSyncExternalStore`). Returns an unsubscribe fn. */
export function subscribeAutomationTrace(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Monotonic version token; changes on every new entry (a stable `getSnapshot`). */
export function getAutomationTraceVersion(): number {
  return seq;
}

/** Current trace entries (oldest first). */
export function getAutomationTrace(): readonly AutomationTraceEntry[] {
  return entries;
}

/** Clear the trace buffer. */
export function clearAutomationTrace(): void {
  entries.length = 0;
  for (const listener of listeners) {
    listener();
  }
}

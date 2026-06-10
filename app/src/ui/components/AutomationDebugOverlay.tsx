/**
 * Live, on-screen automation trace — a "thinking stream" for debug builds only.
 *
 * Rendered by {@link ProcureFlow} only when {@link isAutomationDebug} is true. It subscribes to the
 * shared trace store and shows the rolling perceive → plan → act → verify → fail log (the same lines
 * also go to `adb logcat`). Collapsible, auto-scrolling, and floats above the app UI (it cannot float
 * above the native WebView, which is expected — when the WebView is visible you watch the real page).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  clearAutomationTrace,
  getAutomationTrace,
  getAutomationTraceVersion,
  subscribeAutomationTrace,
  type AutomationTraceLevel,
} from "../../core/debug/automationDebug";

const LEVEL_LABEL: Record<AutomationTraceLevel, string> = {
  think: "··",
  info: "ok",
  warn: "!",
  error: "✗",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/** Render the whole trace as plain text for copy/paste. */
function traceToText(): string {
  return getAutomationTrace()
    .map(
      (e) =>
        `${formatTime(e.at)} [${e.level}]${e.platform ? ` [${e.platform}]` : ""} ${e.message}`,
    )
    .join("\n");
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

export function AutomationDebugOverlay(): JSX.Element {
  useSyncExternalStore(subscribeAutomationTrace, getAutomationTraceVersion, getAutomationTraceVersion);
  const entries = getAutomationTrace();
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!collapsed && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [entries.length, collapsed]);

  const copyAll = async (): Promise<void> => {
    const text = traceToText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
    } catch {
      fallbackCopy(text);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`pc-debug ${collapsed ? "pc-debug--collapsed" : ""}`} data-testid="automation-debug">
      <div className="pc-debug__bar">
        <span className="pc-debug__title">
          <span className="pc-debug__dot" /> Automation debug · {entries.length}
        </span>
        <span className="pc-debug__actions">
          <button
            type="button"
            className="pc-debug__btn pc-debug__btn--primary"
            onClick={() => void copyAll()}
            data-testid="automation-debug-copy"
          >
            {copied ? "copied ✓" : "copy all"}
          </button>
          <button type="button" className="pc-debug__btn" onClick={() => clearAutomationTrace()}>
            clear
          </button>
          <button type="button" className="pc-debug__btn" onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? "show" : "hide"}
          </button>
        </span>
      </div>
      {collapsed ? null : (
        <div className="pc-debug__body" ref={bodyRef}>
          {entries.length === 0 ? (
            <div className="pc-debug__empty">Waiting for automation activity…</div>
          ) : (
            entries.map((e) => (
              <div key={e.id} className={`pc-debug__line pc-debug__line--${e.level}`}>
                <span className="pc-debug__t">{formatTime(e.at)}</span>
                <span className="pc-debug__lvl">{LEVEL_LABEL[e.level]}</span>
                {e.platform ? <span className="pc-debug__plat">{e.platform}</span> : null}
                <span className="pc-debug__msg">{e.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

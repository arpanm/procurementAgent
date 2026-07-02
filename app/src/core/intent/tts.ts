/**
 * Best-effort text-to-speech via the Web Speech API (`window.speechSynthesis`), for the comparison
 * "read back" accessibility control (the low-literacy target user). No-op when unavailable (tests / a
 * WebView without TTS), so callers can wire it unconditionally.
 */

interface SpeechSynthesisLike {
  cancel(): void;
  speak(utterance: unknown): void;
}

function synth(): SpeechSynthesisLike | undefined {
  try {
    const g = globalThis as unknown as {
      speechSynthesis?: SpeechSynthesisLike;
      SpeechSynthesisUtterance?: unknown;
    };
    if (g.speechSynthesis && typeof g.SpeechSynthesisUtterance === "function") {
      return g.speechSynthesis;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** True when the browser/WebView can actually speak (so the UI can hide the control otherwise). */
export function isTtsAvailable(): boolean {
  return synth() !== undefined;
}

/** Speak `text` (cancelling any in-progress utterance). Best-effort: silently no-ops when unavailable. */
export function speakText(text: string, locale?: string): void {
  const s = synth();
  if (!s || !text) return;
  try {
    const Utterance = (globalThis as unknown as {
      SpeechSynthesisUtterance: new (t: string) => { lang?: string };
    }).SpeechSynthesisUtterance;
    const utter = new Utterance(text);
    if (locale) utter.lang = locale;
    s.cancel();
    s.speak(utter);
  } catch {
    /* ignore */
  }
}

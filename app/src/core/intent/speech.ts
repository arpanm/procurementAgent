/**
 * Thin speech-input seam (PROCURE_COPILOT_PLAN.md §3.2, Epic 1 "voice push-to-talk").
 *
 * Push-to-talk STT runs on-device via the Android `SpeechRecognizer` (Hindi/Bengali/English mixed
 * register) — it is NOT an LLM call. Native STT cannot run in CI/jsdom, so all callers depend only on
 * this small interface and a {@link NoopSpeechInput} stub is used in tests and web preview. A real
 * Capacitor/native implementation is dropped in behind the same interface later.
 */

/** A partial or final transcription emitted while/after the user speaks. */
export interface SpeechResult {
  /** Best-guess transcript so far. */
  readonly transcript: string;
  /** True once recognition has finished and this is the final transcript. */
  readonly isFinal: boolean;
}

export type SpeechResultListener = (result: SpeechResult) => void;
export type SpeechErrorListener = (error: Error) => void;

export interface SpeechInput {
  /** True while a recognition session is active (mic is "hot"). */
  readonly isListening: boolean;
  /**
   * Begins a push-to-talk recognition session for the given BCP-47 locale (e.g. "hi-IN", "bn-IN",
   * "en-IN"). Safe to call only when not already listening.
   */
  start(locale?: string): Promise<void>;
  /** Ends the current recognition session; the final result (if any) arrives via onResult. */
  stop(): Promise<void>;
  /** Subscribes to partial/final results. Returns an unsubscribe function. */
  onResult(listener: SpeechResultListener): () => void;
  /** Subscribes to recognition errors. Returns an unsubscribe function. */
  onError(listener: SpeechErrorListener): () => void;
}

/**
 * No-op stub used in tests and on the web where native STT is unavailable. It tracks listening state
 * and lets tests drive results deterministically via {@link emit} without any platform dependency.
 */
export class NoopSpeechInput implements SpeechInput {
  private listening = false;
  private readonly resultListeners = new Set<SpeechResultListener>();
  private readonly errorListeners = new Set<SpeechErrorListener>();

  get isListening(): boolean {
    return this.listening;
  }

  async start(): Promise<void> {
    this.listening = true;
  }

  async stop(): Promise<void> {
    this.listening = false;
  }

  onResult(listener: SpeechResultListener): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  onError(listener: SpeechErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Test hook: simulate a recognition result reaching all subscribers. */
  emit(result: SpeechResult): void {
    for (const listener of this.resultListeners) {
      listener(result);
    }
  }

  /** Test hook: simulate a recognition error reaching all subscribers. */
  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

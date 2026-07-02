/**
 * Conversation surface — "type or speak your order" (PROCURE_COPILOT_PLAN.md Epic 1, §3.1/§3.6).
 *
 * Lets the retailer type or push-to-talk an order, parses it through the {@link IntentClient} (which
 * scrubs secrets on-device before any API call), and renders the result as an EDITABLE item list —
 * qty stepper, unit select, delete — plus confirmation chips and a confirm action. All copy is
 * multilingual (en/hi/bn). The {@link IntentClient} and {@link SpeechInput} are injected via props so
 * the page is testable without a backend or native STT.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IonButton,
  IonChip,
  IonContent,
  IonFooter,
  IonInput,
  IonNote,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonText,
} from "@ionic/react";
import type { RequestedItem, Unit } from "../../core/domain/types";
import { HttpBackendClient } from "../../core/backend/BackendClient";
import { BACKEND_BASE_URLS } from "../../core/config";
import { IntentClient } from "../../core/intent/IntentClient";
import {
  addItem,
  editQty,
  editTextField,
  editUnit,
  type ItemTextField,
  removeItem,
  SELECTABLE_UNITS,
  summarize,
} from "../../core/intent/itemListModel";
import { NoopSpeechInput, type SpeechInput } from "../../core/intent/speech";
import {
  getStrings,
  type Lang,
  langFromLocale,
  SUPPORTED_LANGS,
} from "../../core/intent/strings";
import { BrandHeader } from "../components/BrandHeader";

/** Persisted UI-language key + the BCP-47 locale / native name for each supported language. */
const LANG_KEY = "pc.lang";
const LANG_LOCALE: Record<Lang, string> = { en: "en-IN", hi: "hi-IN", bn: "bn-IN" };
const LANG_NAMES: Record<Lang, string> = { en: "English", hi: "हिन्दी", bn: "বাংলা" };

/** Initial language: explicit prop → persisted choice → device language → English. */
function initialLang(localeProp?: string): Lang {
  if (localeProp) return langFromLocale(localeProp);
  try {
    const saved = globalThis.localStorage?.getItem(LANG_KEY);
    if (saved) return langFromLocale(saved);
  } catch {
    /* ignore */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : undefined;
  return langFromLocale(nav);
}

export interface ChatPageProps {
  /** Injected for testing; defaults to an HTTP-backed client. */
  readonly intentClient?: IntentClient;
  /** Injected for testing / web preview; defaults to a no-op (native STT can't run here). */
  readonly speech?: SpeechInput;
  /** BCP-47 locale driving both the UI language and the intent request, e.g. "hi-IN". */
  readonly locale?: string;
  /** Fired with the (edited) item list when the retailer confirms the order. */
  readonly onConfirm?: (items: readonly RequestedItem[]) => void;
}

function makeBlankItem(): RequestedItem {
  return { raw: "", name: "", qty: 1, unit: "piece" };
}

/** Inline microphone glyph (avoids a runtime icon-font dependency). */
function MicGlyph(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * The page component. Exported as {@link ChatPage} so the parent can wire it into routing.
 */
export function ChatPage({
  intentClient,
  speech,
  locale,
  onConfirm,
}: ChatPageProps): JSX.Element {
  const client = useMemo(
    () => intentClient ?? new IntentClient(new HttpBackendClient(BACKEND_BASE_URLS)),
    [intentClient],
  );
  const speechRef = useRef<SpeechInput | null>(null);
  if (speechRef.current === null) {
    speechRef.current = speech ?? new NoopSpeechInput();
  }
  const speechInput = speech ?? speechRef.current;

  // UI language: a persisted, user-selectable choice (seeded from the prop / device language). Drives
  // both the on-screen strings and the locale sent to the intent parser + speech recognizer.
  const [lang, setLang] = useState<Lang>(() => initialLang(locale));
  const strings = useMemo(() => getStrings(lang), [lang]);
  const effectiveLocale = LANG_LOCALE[lang];
  const micAvailable = speechInput.isAvailable;
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(LANG_KEY, lang);
    } catch {
      /* private mode / no storage → in-memory only */
    }
  }, [lang]);

  const [text, setText] = useState("");
  const [items, setItems] = useState<readonly RequestedItem[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribeResult = speechInput.onResult((result) => {
      setText(result.transcript);
    });
    const unsubscribeError = speechInput.onError(() => {
      setErrorNote(strings.errorParsing);
      setIsListening(false);
    });
    return () => {
      unsubscribeResult();
      unsubscribeError();
    };
  }, [speechInput, strings]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || isParsing) {
      return;
    }
    setIsParsing(true);
    setErrorNote(null);
    setErrorDetail(null);
    setStatusNote(null);
    try {
      const result = await client.parseWithConfidence(trimmed, effectiveLocale);
      setItems(result.items);
      if (result.items.length === 0) {
        setStatusNote(strings.noItemsFound);
      } else if (result.lowConfidence) {
        setStatusNote(strings.lowConfidence);
      }
    } catch (err) {
      setErrorNote(strings.errorParsing);
      // Surface the underlying cause + the backend URL we tried, so connectivity problems on a
      // device (wrong host, cleartext blocked, backend down) are diagnosable instead of opaque.
      const message = err instanceof Error ? err.message : String(err);
      setErrorDetail(`${message} · tried ${BACKEND_BASE_URLS.join(", ")}`);
    } finally {
      setIsParsing(false);
    }
  }, [client, effectiveLocale, isParsing, strings, text]);

  const handleMicDown = useCallback(async () => {
    setErrorNote(null);
    setIsListening(true);
    try {
      await speechInput.start(effectiveLocale);
    } catch {
      setIsListening(false);
      setErrorNote(strings.errorParsing);
    }
  }, [effectiveLocale, speechInput, strings]);

  const handleMicUp = useCallback(async () => {
    if (!isListening) {
      return;
    }
    setIsListening(false);
    await speechInput.stop();
  }, [isListening, speechInput]);

  const handleQtyDelta = useCallback((index: number, delta: number) => {
    setItems((current) => {
      const target = current[index];
      if (!target) {
        return current;
      }
      return editQty(current, index, target.qty + delta);
    });
  }, []);

  const handleUnitChange = useCallback((index: number, unit: Unit) => {
    setItems((current) => editUnit(current, index, unit));
  }, []);

  const handleTextField = useCallback(
    (index: number, field: ItemTextField, value: string) => {
      setItems((current) => editTextField(current, index, field, value));
    },
    [],
  );

  const handleRemove = useCallback((index: number) => {
    setItems((current) => removeItem(current, index));
  }, []);

  const handleAddItem = useCallback(() => {
    setItems((current) => addItem(current, makeBlankItem()));
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm?.(items);
  }, [items, onConfirm]);

  const hasItems = items.length > 0;
  const summaryLines = useMemo(
    () => (hasItems ? summarize(items).split("\n") : []),
    [hasItems, items],
  );

  return (
    <IonPage>
      <BrandHeader title={strings.title} subtitle={strings.tagline} />
      <IonContent className="ion-padding pc-content">
        <div className="pc-lang-row">
          <IonSelect
            className="pc-lang-select"
            data-testid="lang-select"
            aria-label="Language"
            interface="popover"
            value={lang}
            onIonChange={(event) => setLang(event.detail.value as Lang)}
          >
            {SUPPORTED_LANGS.map((l) => (
              <IonSelectOption key={l} value={l}>
                {LANG_NAMES[l]}
              </IonSelectOption>
            ))}
          </IonSelect>
        </div>
        <div className="pc-composer">
          <IonInput
            className="pc-composer__input"
            data-testid="order-input"
            aria-label={strings.inputPlaceholder}
            placeholder={strings.inputPlaceholder}
            value={text}
            onIonInput={(event) => setText(event.detail.value ?? "")}
          />
          {micAvailable ? (
            <IonButton
              className={`pc-iconbtn${isListening ? " pc-mic--listening" : ""}`}
              data-testid="mic-button"
              aria-label={isListening ? strings.micStop : strings.micStart}
              aria-pressed={isListening}
              fill="clear"
              color={isListening ? "danger" : "medium"}
              onPointerDown={handleMicDown}
              onPointerUp={handleMicUp}
              onPointerLeave={handleMicUp}
            >
              <MicGlyph />
            </IonButton>
          ) : null}
          <IonButton
            className="pc-sendbtn"
            data-testid="send-button"
            aria-label={strings.send}
            shape="round"
            disabled={isParsing || text.trim().length === 0}
            onClick={handleSend}
          >
            {strings.send}
          </IonButton>
        </div>

        {isListening && micAvailable ? (
          <div className="pc-listening-note" data-testid="listening-note">
            <span className="pc-listening-dot" />
            <IonNote color="danger">{strings.listening}</IonNote>
          </div>
        ) : null}

        {isParsing ? (
          <div className="pc-banner pc-banner--info" data-testid="parsing-indicator">
            <IonSpinner name="dots" aria-label={strings.parsing} />
            <IonNote>{strings.parsing}</IonNote>
          </div>
        ) : null}

        {errorNote ? (
          <IonText color="danger" role="alert" data-testid="error-note">
            <p className="pc-banner pc-banner--error">
              {errorNote}
              {errorDetail ? (
                <span className="pc-banner__detail" data-testid="error-detail">
                  {errorDetail}
                </span>
              ) : null}
            </p>
          </IonText>
        ) : null}

        {statusNote ? (
          <IonText color="warning" role="status" data-testid="status-note">
            <p className="pc-banner pc-banner--warn">{statusNote}</p>
          </IonText>
        ) : null}

        {!hasItems && !isParsing && !statusNote ? (
          <div className="pc-hero" data-testid="empty-state">
            <span className="pc-hero__icon">
              <MicGlyph />
            </span>
            <h1 className="pc-hero__title">{strings.emptyState}</h1>
            <p className="pc-hero__subtitle">{strings.tagline}</p>
            <div className="pc-hero__examples">
              {strings.heroExamples.map((example) => (
                <span
                  key={example}
                  className="pc-hero__chip"
                  role="button"
                  tabIndex={0}
                  onClick={() => setText(example)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setText(example);
                    }
                  }}
                >
                  “{example}”
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {hasItems ? (
          <>
            <p className="pc-section-title">{strings.parsedHeading}</p>

            <div className="pc-chips" data-testid="confirmation-chips">
              {summaryLines.map((line, index) => (
                <IonChip className="pc-chip" key={`chip-${index}-${line}`}>
                  {line}
                </IonChip>
              ))}
            </div>

            <div data-testid="item-list">
              {items.map((item, index) => (
                <div className="pc-card" key={`item-${index}`} data-testid={`item-${index}`}>
                  <div className="pc-card__head">
                    <div className="pc-line__main">
                      <h3 className="pc-line__name" data-testid={`item-name-${index}`}>
                        {item.name || item.raw || strings.addItem}
                      </h3>
                      <p className="pc-line__reason">
                        {strings.qtyLabel}:{" "}
                        <span data-testid={`qty-value-${index}`}>{item.qty}</span>{" "}
                        <span data-testid={`unit-value-${index}`}>{item.unit}</span>
                      </p>
                      {item.brand || item.variant || item.packSize ? (
                        <p className="pc-line__meta" data-testid={`item-meta-${index}`}>
                          {[item.brand, item.variant, item.packSize]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      ) : null}
                    </div>
                    <IonButton
                      className="pc-iconbtn"
                      data-testid={`remove-${index}`}
                      aria-label={strings.remove}
                      fill="clear"
                      color="danger"
                      onClick={() => handleRemove(index)}
                    >
                      ✕
                    </IonButton>
                  </div>
                  <div className="pc-card__body">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <div className="pc-stepper" role="group" aria-label={strings.qtyLabel}>
                        <IonButton
                          data-testid={`qty-decrement-${index}`}
                          aria-label={`${strings.qtyLabel} -`}
                          fill="clear"
                          onClick={() => handleQtyDelta(index, -1)}
                        >
                          −
                        </IonButton>
                        <span className="pc-stepper__value" aria-hidden="true">
                          {item.qty}
                        </span>
                        <IonButton
                          data-testid={`qty-increment-${index}`}
                          aria-label={`${strings.qtyLabel} +`}
                          fill="clear"
                          onClick={() => handleQtyDelta(index, 1)}
                        >
                          +
                        </IonButton>
                      </div>
                      <IonSelect
                        data-testid={`unit-select-${index}`}
                        aria-label={strings.unitLabel}
                        interface="popover"
                        value={item.unit}
                        onIonChange={(event) =>
                          handleUnitChange(index, event.detail.value as Unit)
                        }
                      >
                        {SELECTABLE_UNITS.map((unit) => (
                          <IonSelectOption key={unit} value={unit}>
                            {unit}
                          </IonSelectOption>
                        ))}
                      </IonSelect>
                    </div>

                    <div className="pc-refinements">
                      <IonInput
                        className="pc-refinements__field"
                        data-testid={`brand-input-${index}`}
                        label={strings.brandLabel}
                        labelPlacement="stacked"
                        placeholder={strings.optionalHint}
                        value={item.brand ?? ""}
                        onIonInput={(event) =>
                          handleTextField(index, "brand", event.detail.value ?? "")
                        }
                      />
                      <IonInput
                        className="pc-refinements__field"
                        data-testid={`variant-input-${index}`}
                        label={strings.variantLabel}
                        labelPlacement="stacked"
                        placeholder={strings.optionalHint}
                        value={item.variant ?? ""}
                        onIonInput={(event) =>
                          handleTextField(index, "variant", event.detail.value ?? "")
                        }
                      />
                      <IonInput
                        className="pc-refinements__field"
                        data-testid={`packsize-input-${index}`}
                        label={strings.packSizeLabel}
                        labelPlacement="stacked"
                        placeholder={strings.optionalHint}
                        value={item.packSize ?? ""}
                        onIonInput={(event) =>
                          handleTextField(index, "packSize", event.detail.value ?? "")
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <IonButton
              className="ion-margin-top"
              data-testid="add-item-button"
              expand="block"
              fill="outline"
              onClick={handleAddItem}
            >
              {strings.addItem}
            </IonButton>
          </>
        ) : null}
      </IonContent>

      {hasItems ? (
        <IonFooter className="ion-no-border">
          <div className="pc-sticky-bar">
            <IonButton
              className="pc-cta"
              data-testid="confirm-button"
              expand="block"
              onClick={handleConfirm}
            >
              {strings.confirm}
            </IonButton>
          </div>
        </IonFooter>
      ) : null}
    </IonPage>
  );
}

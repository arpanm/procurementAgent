/**
 * The OTP / payment hand-off screen (PROCURE_COPILOT_PLAN.md §3.5.9, Epic 6). When the checkout driver
 * hits an OTP or payment gate it PAUSES and surfaces this screen. The user reveals the live platform
 * webview, enters the OTP / completes payment INSIDE the real site, then taps "Done" to resume.
 *
 * Procure Copilot never automates OTP or payment — this page has no input field for either. It only
 * (a) shows the platform's own prompt, (b) reveals the live webview (`engine.show()` via `onReveal`),
 * and (c) resolves the human-resume hook (`onDone`). Fully prop-driven for testability.
 */
import { IonButton, IonContent, IonFooter, IonPage } from "@ionic/react";
import type { PlatformId } from "../../core/domain/types";
import { formatRupees } from "../../core/domain/types";
import { BrandHeader } from "../components/BrandHeader";

export interface OtpPaymentPageProps {
  readonly platform: PlatformId;
  readonly kind: "otp" | "payment";
  /** The platform's own prompt, e.g. "Enter the OTP Hyperpure just sent you". */
  readonly prompt: string;
  /** Amount due, in paise — shown for the payment hand-off. */
  readonly amountPaise?: number;
  /** Reveal the live webview (wires to `engine.show()`). */
  readonly onReveal: () => void;
  /** Resolve the human-resume hook (the driver's `awaitHuman()` resolves here). */
  readonly onDone: () => void;
  /** Whether the live webview is currently revealed (drives the button label/state). */
  readonly revealed?: boolean;
}

export function OtpPaymentPage({
  platform,
  kind,
  prompt,
  amountPaise,
  onReveal,
  onDone,
  revealed = false,
}: OtpPaymentPageProps): JSX.Element {
  const title = kind === "otp" ? "Enter OTP" : "Complete payment";
  const capitalizedPlatform =
    platform.charAt(0).toUpperCase() + platform.slice(1);
  const instruction =
    kind === "otp"
      ? `Switch to ${capitalizedPlatform} and enter the OTP they sent you.`
      : `Switch to ${capitalizedPlatform} and complete the payment to place this order.`;

  return (
    <IonPage>
      <BrandHeader title={title} subtitle={`${capitalizedPlatform} hand-off`} />
      <IonContent className="ion-padding pc-content">
        <div className="pc-handoff-card">
          <span className="pc-handoff-card__icon" aria-hidden="true">
            {kind === "otp" ? <KeyGlyph /> : <CardGlyph />}
          </span>

          <h2 className="pc-handoff-card__platform" data-testid="handoff-platform">
            {capitalizedPlatform}
          </h2>
          <p className="pc-line__reason" style={{ marginTop: 4 }}>
            {instruction}
          </p>
          <p className="pc-handoff-card__prompt" data-testid="handoff-prompt">
            {prompt}
          </p>

          {kind === "payment" && amountPaise !== undefined ? (
            <span className="pc-amount-chip" data-testid="handoff-amount">
              {formatRupees(amountPaise)} due
            </span>
          ) : null}

          <p className="pc-trust-note">
            <ShieldGlyph />
            {kind === "otp"
              ? "We never read or type your OTP. Enter it directly on the platform's own screen."
              : "We never handle your card. Pay directly inside the platform's own checkout."}
          </p>
        </div>
      </IonContent>

      <IonFooter className="ion-no-border">
        <div className="pc-sticky-bar">
          <IonButton
            className="pc-cta"
            data-testid="reveal-button"
            expand="block"
            onClick={onReveal}
            aria-pressed={revealed}
          >
            {revealed ? `${capitalizedPlatform} is open below` : `Show me the ${capitalizedPlatform} page`}
          </IonButton>
          <IonButton
            className="pc-cta"
            data-testid="done-button"
            expand="block"
            fill="outline"
            color="success"
            onClick={onDone}
          >
            I&apos;ve done this
          </IonButton>
        </div>
      </IonFooter>
    </IonPage>
  );
}

/** Inline key glyph for the OTP hand-off. */
function KeyGlyph(): JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="10" r="4.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M11 12l8 8M16 17l2-2M19 20l2-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Inline card glyph for the payment hand-off. */
function CardGlyph(): JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M2.5 9.5h19" stroke="currentColor" strokeWidth="2" />
      <path d="M6 15h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Inline shield glyph for the trust/reassurance note. */
function ShieldGlyph(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flex: "0 0 auto" }}
    >
      <path
        d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

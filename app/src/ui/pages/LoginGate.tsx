/**
 * First-run sign-in gate (PROCURE_COPILOT_PLAN.md §6 — the human does the one-time login).
 *
 * Before the app searches or adds to cart, the user must manually sign in to each active platform's
 * WebView (phone OTP + delivery-location selection can't be automated). For each platform this screen
 * offers "Open & sign in", which foregrounds that platform's WebView; when the user closes it they
 * confirm "I've signed in", which persists via {@link confirmLogin}. Once every active platform is
 * confirmed, {@link onReady} advances to the chat. The confirmation survives app restarts, so this gate
 * is shown only until the one-time setup is done (re-openable via "reset" from the summary later).
 */
import { useState } from "react";
import { IonButton, IonContent, IonPage, IonSpinner } from "@ionic/react";
import type { PlatformId } from "../../core/domain/types";
import { confirmLogin, isLoginConfirmed } from "../../core/auth/loginStore";
import { BrandHeader } from "../components/BrandHeader";

const PLATFORM_LABEL: Record<PlatformId, string> = {
  hyperpure: "Hyperpure",
  amazon: "Amazon.in",
};

type RowState = "idle" | "opening" | "returned" | "confirmed";

export interface LoginGateProps {
  /** Platforms that must be signed in before procurement can start. */
  readonly platforms: readonly PlatformId[];
  /** Foreground the platform's WebView for manual sign-in; resolves when the user closes that window. */
  readonly onOpenLogin: (platform: PlatformId) => Promise<void>;
  /** Called once every platform is confirmed signed-in. */
  readonly onReady: () => void;
}

export function LoginGate({ platforms, onOpenLogin, onReady }: LoginGateProps): JSX.Element {
  // Seed each row from persisted confirmations so a partially-done setup resumes correctly.
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      platforms.map((p) => [p, isLoginConfirmed(p) ? "confirmed" : "idle"] as const),
    ),
  );

  const setRow = (platform: PlatformId, state: RowState): void =>
    setRows((prev) => ({ ...prev, [platform]: state }));

  const allConfirmed = platforms.every((p) => rows[p] === "confirmed");

  const openLogin = async (platform: PlatformId): Promise<void> => {
    setRow(platform, "opening");
    try {
      await onOpenLogin(platform);
    } finally {
      // Whether they finished or just closed it, surface the explicit confirm step.
      setRow(platform, "returned");
    }
  };

  const confirm = (platform: PlatformId): void => {
    confirmLogin(platform);
    setRow(platform, "confirmed");
  };

  return (
    <IonPage>
      <BrandHeader title="Procure Copilot" subtitle="One-time sign-in" />
      <IonContent className="ion-padding pc-content">
        <div className="pc-section">
          <h2 className="pc-handoff-card__platform">Sign in to your suppliers</h2>
          <p className="pc-handoff-card__prompt">
            Open each store, sign in and set your delivery location, then come back and confirm. We do
            this once — your session is remembered on this device. We never see your password or OTP.
          </p>
        </div>

        {platforms.map((platform) => {
          const state = rows[platform] ?? "idle";
          const label = PLATFORM_LABEL[platform];
          return (
            <div className="pc-handoff-card" key={platform} style={{ marginBottom: 12 }}>
              <h3 className="pc-handoff-card__platform">{label}</h3>
              {state === "confirmed" ? (
                <p className="pc-handoff-card__prompt" style={{ color: "var(--ion-color-success)" }}>
                  ✓ Signed in
                </p>
              ) : (
                <>
                  <IonButton
                    className="pc-cta"
                    expand="block"
                    disabled={state === "opening"}
                    onClick={() => void openLogin(platform)}
                  >
                    {state === "opening" ? (
                      <>
                        <IonSpinner name="crescent" /> &nbsp;Opening {label}…
                      </>
                    ) : state === "returned" ? (
                      `Open ${label} again`
                    ) : (
                      `Open & sign in to ${label}`
                    )}
                  </IonButton>
                  {state === "returned" ? (
                    <IonButton
                      fill="outline"
                      expand="block"
                      style={{ marginTop: 8 }}
                      onClick={() => confirm(platform)}
                    >
                      I've signed in to {label}
                    </IonButton>
                  ) : null}
                </>
              )}
            </div>
          );
        })}

        <div className="pc-section">
          <IonButton
            className="pc-cta"
            expand="block"
            disabled={!allConfirmed}
            onClick={() => onReady()}
          >
            {allConfirmed ? "Continue" : "Sign in to all stores to continue"}
          </IonButton>
        </div>
      </IonContent>
    </IonPage>
  );
}

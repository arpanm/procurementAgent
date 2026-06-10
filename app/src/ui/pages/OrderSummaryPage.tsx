/**
 * The order summary screen (PROCURE_COPILOT_PLAN.md Epic 6). After checkout it shows, per platform,
 * the order reference, total (in rupees), and whether it was paid on credit or paid now — plus a
 * grand total across all placed orders. Fully prop-driven for testability.
 */
import { IonButton, IonContent, IonFooter, IonNote, IonPage } from "@ionic/react";
import type { OrderAttempt } from "../../core/domain/types";
import { formatRupees } from "../../core/domain/types";
import { OrderReceiptCard } from "../components/OrderReceiptCard";
import { BrandHeader } from "../components/BrandHeader";

export interface OrderSummaryPageProps {
  readonly attempts: readonly OrderAttempt[];
}

/** Success check glyph for the summary hero. */
function CheckGlyph(): JSX.Element {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OrderSummaryPage({ attempts }: OrderSummaryPageProps): JSX.Element {
  const placed = attempts.filter((a) => a.status === "placed");
  const grandTotalPaise = placed.reduce((sum, a) => sum + a.totalPaise, 0);
  const allPlaced = attempts.length > 0 && placed.length === attempts.length;

  const startNewOrder = (): void => {
    window.location.assign("/");
  };

  return (
    <IonPage>
      <BrandHeader title="Order summary" subtitle="Your procurement run" />
      <IonContent className="ion-padding pc-content">
        {attempts.length === 0 ? (
          <div className="pc-hero" data-testid="summary-empty">
            <h1 className="pc-hero__title">No orders yet</h1>
            <p className="pc-hero__subtitle">
              Place an order to see your receipts and savings here.
            </p>
          </div>
        ) : (
          <>
            <div className="pc-success-hero" role="status">
              <span
                className="pc-success-hero__badge"
                style={
                  allPlaced
                    ? undefined
                    : {
                        background: "rgba(var(--ion-color-warning-rgb), 0.16)",
                        color: "var(--ion-color-warning-shade)",
                      }
                }
                aria-hidden="true"
              >
                <CheckGlyph />
              </span>
              <h2 className="pc-success-hero__title" data-testid="summary-headline">
                {allPlaced
                  ? "All orders placed"
                  : `${placed.length} of ${attempts.length} orders placed`}
              </h2>
              <p className="pc-success-hero__sub">
                <IonNote data-testid="summary-placed-count">
                  {placed.length} order{placed.length === 1 ? "" : "s"} placed.
                </IonNote>
              </p>
            </div>

            {attempts.map((attempt) => (
              <OrderReceiptCard key={attempt.platform} attempt={attempt} />
            ))}

            <div className="pc-grandtotal">
              <span className="pc-grandtotal__label">Grand total</span>
              <span className="pc-grandtotal__value" data-testid="summary-grand-total">
                {formatRupees(grandTotalPaise)}
              </span>
            </div>
          </>
        )}
      </IonContent>

      {attempts.length > 0 ? (
        <IonFooter className="ion-no-border">
          <div className="pc-sticky-bar">
            <IonButton className="pc-cta" expand="block" onClick={startNewOrder}>
              Start new order
            </IonButton>
          </div>
        </IonFooter>
      ) : null}
    </IonPage>
  );
}

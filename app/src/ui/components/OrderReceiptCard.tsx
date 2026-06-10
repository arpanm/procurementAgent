/**
 * Presentational per-platform order receipt (PROCURE_COPILOT_PLAN.md Epic 6). Renders one
 * {@link OrderAttempt}: the platform, its status, the order reference, the total in rupees, and
 * whether it was paid on credit or paid now. Pure/stateless.
 */
import { IonNote, IonText } from "@ionic/react";
import type { OrderAttempt } from "../../core/domain/types";
import { formatRupees } from "../../core/domain/types";

export interface OrderReceiptCardProps {
  readonly attempt: OrderAttempt;
}

const STATUS_LABEL: Record<OrderAttempt["status"], string> = {
  pending: "Pending",
  cart_filled: "Cart filled",
  needs_otp: "Waiting for OTP",
  needs_payment: "Waiting for payment",
  placed: "Order placed",
  failed: "Failed",
};

export function OrderReceiptCard({ attempt }: OrderReceiptCardProps): JSX.Element {
  const placed = attempt.status === "placed";
  const capitalizedPlatform =
    attempt.platform.charAt(0).toUpperCase() + attempt.platform.slice(1);

  return (
    <section className="pc-card" data-testid={`receipt-${attempt.platform}`}>
      <div className="pc-card__head">
        <span className={`pc-platform pc-platform--${attempt.platform}`}>
          <span className="pc-platform__dot" />
          <span className="pc-platform__name">{capitalizedPlatform}</span>
        </span>
        <span
          className="pc-platform-pill"
          data-testid={`receipt-status-${attempt.platform}`}
          style={{
            color: placed ? "var(--ion-color-success)" : "var(--ion-color-medium)",
          }}
        >
          {STATUS_LABEL[attempt.status]}
        </span>
      </div>

      <div className="pc-card__body">
        {attempt.orderRef ? (
          <IonText>
            <p data-testid={`receipt-ref-${attempt.platform}`} className="pc-line__reason">
              Order reference: <strong style={{ color: "var(--ion-text-color)" }}>{attempt.orderRef}</strong>
            </p>
          </IonText>
        ) : (
          <IonNote data-testid={`receipt-noref-${attempt.platform}`}>
            No order reference{placed ? "" : " — order not placed"}.
          </IonNote>
        )}
      </div>

      <div className="pc-card__footer">
        <span
          className="pc-platform-pill"
          data-testid={`receipt-payment-${attempt.platform}`}
          style={{
            color: attempt.paidOnCredit
              ? "var(--ion-color-success)"
              : "var(--ion-color-medium)",
          }}
        >
          {attempt.paidOnCredit ? "Paid on credit" : "Paid at checkout"}
        </span>
        <span className="pc-money pc-money--strong" data-testid={`receipt-total-${attempt.platform}`}>
          {formatRupees(attempt.totalPaise)}
        </span>
      </div>
    </section>
  );
}

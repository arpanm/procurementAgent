/**
 * Presentational comparison card (PROCURE_COPILOT_PLAN.md Epic 5, §4). Renders the optimizer's
 * {@link Allocation} entirely in rupees: a per-platform breakdown with each line's plain-language
 * reason, per-platform subtotal + delivery + total, the grand total, and the saving versus the
 * cheapest single-platform baseline. Pure/stateless — it only takes an `allocation` plus optional
 * per-line edit controls rendered by the parent (kept out of here so this stays presentational).
 */
import { IonText } from "@ionic/react";
import type { ReactNode } from "react";
import type { Allocation, AllocationLine } from "../../core/domain/types";
import { formatRupees } from "../../core/domain/types";
import { platformLabel } from "../../core/config";

export interface AllocationCardProps {
  readonly allocation: Allocation;
  /** Optional per-line edit controls (qty stepper, swap, drop) injected by the parent. */
  readonly renderLineControls?: (line: AllocationLine) => ReactNode;
}

export function AllocationCard({
  allocation,
  renderLineControls,
}: AllocationCardProps): JSX.Element {
  const saved = allocation.savingPaise < 0;

  return (
    <div data-testid="allocation-card">
      {allocation.perPlatform.map((platform) => (
        <section
          key={platform.platform}
          className="pc-card"
          data-testid={`platform-${platform.platform}`}
        >
          <div className="pc-card__head">
            <span className={`pc-platform pc-platform--${platform.platform}`}>
              <span className="pc-platform__dot" />
              <span className="pc-platform__name">{platformLabel(platform.platform)}</span>
            </span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {platform.payableOnCredit ? (
                <span className="pc-platform-pill" style={{ color: "var(--ion-color-success)" }}>
                  On credit
                </span>
              ) : null}
              {platform.meetsMov ? null : (
                <span className="pc-platform-pill" style={{ color: "var(--ion-color-warning-shade)" }}>
                  Below min order
                </span>
              )}
            </span>
          </div>

          <div className="pc-card__body">
            {platform.lines.map((line) => (
              <div
                className="pc-line"
                key={`${platform.platform}-${line.canonicalItemId}`}
                data-testid={`line-${platform.platform}-${line.canonicalItemId}`}
              >
                <div className="pc-line__main">
                  <h3 className="pc-line__name">
                    {line.itemName} × {line.qty}
                  </h3>
                  <p
                    className="pc-line__reason"
                    data-testid={`reason-${platform.platform}-${line.canonicalItemId}`}
                  >
                    {line.reason}
                  </p>
                  {renderLineControls ? (
                    <div style={{ marginTop: 8 }}>{renderLineControls(line)}</div>
                  ) : null}
                </div>
                <div className="pc-line__price pc-money">{formatRupees(line.lineTotalPaise)}</div>
              </div>
            ))}
          </div>

          <div className="pc-card__footer" data-testid={`platform-total-${platform.platform}`}>
            <span className="pc-delivery">
              Subtotal {formatRupees(platform.subtotalPaise)} + delivery{" "}
              {formatRupees(platform.deliveryFeePaise)}
              {platform.meetsMov ? "" : " (below minimum order value)"}
            </span>
            <span className="pc-money pc-money--strong">{formatRupees(platform.totalPaise)}</span>
          </div>
        </section>
      ))}

      {allocation.unfulfilled.length > 0 ? (
        <div className="pc-banner pc-banner--error" data-testid="unfulfilled">
          <IonText color="danger">
            <h3 style={{ margin: "0 0 4px" }}>Could not source</h3>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {allocation.unfulfilled.map((u) => (
                <li key={u.canonicalItemId}>
                  {u.itemName}: {u.reason}
                </li>
              ))}
            </ul>
          </IonText>
        </div>
      ) : null}

      <div className="pc-grandtotal">
        <span className="pc-grandtotal__label">Grand total</span>
        <span className="pc-grandtotal__value" data-testid="grand-total">
          {formatRupees(allocation.grandTotalPaise)}
        </span>
      </div>

      <IonText color={saved ? "success" : "medium"}>
        <p
          data-testid="saving"
          className={saved ? "pc-money--save" : undefined}
          style={{ margin: "0 4px 8px", fontWeight: 600 }}
        >
          {saved
            ? `You save ${formatRupees(-allocation.savingPaise)} vs buying everything on one platform (${formatRupees(
                allocation.singlePlatformBaselinePaise,
              )}).`
            : allocation.savingPaise > 0
              ? `This split costs ${formatRupees(allocation.savingPaise)} more than a single platform; kept for availability.`
              : `No saving vs a single platform.`}
        </p>
      </IonText>
    </div>
  );
}

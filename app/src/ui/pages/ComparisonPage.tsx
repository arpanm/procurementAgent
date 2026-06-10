/**
 * The HITL comparison / approval surface (PROCURE_COPILOT_PLAN.md Epic 5, §3.3, §3.6.4).
 *
 * Shows the optimizer's rupee split (via {@link AllocationCard}), a plain-language explanation with a
 * voice "read back" button, and the three HITL actions — **Proceed / Modify / Cancel**. Under
 * "Modify" the retailer can edit any line (qty stepper, swap platform, drop item); each edit calls
 * `orchestrator.modify(...)`, which RE-OPTIMIZES and, because the page is bound to the orchestrator's
 * store via `useSyncExternalStore`, RE-RENDERS with the new allocation. Nothing irreversible happens
 * here without an explicit Proceed → `orchestrator.approve()`.
 *
 * The `orchestrator` is injected via props (typed structurally) so the page is fully testable with a
 * mock; the real {@link Orchestrator} satisfies {@link ComparisonOrchestrator} structurally.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonNote,
  IonPage,
  IonSpinner,
  IonText,
} from "@ionic/react";
import type { Allocation, AllocationLine, PlatformId } from "../../core/domain/types";
import { formatRupees, SUPPORTED_PLATFORMS } from "../../core/domain/types";
import type { ReadableStore } from "../../core/orchestrator/store";
import type { ModifyChange, SessionState } from "../../core/orchestrator/session";
import { explainAllocation } from "../../core/optimizer/OptimizerClient";
import { AllocationCard } from "../components/AllocationCard";
import { BrandHeader } from "../components/BrandHeader";

/** The minimal orchestrator surface this page needs (the real Orchestrator satisfies it). */
export interface ComparisonOrchestrator extends ReadableStore<SessionState> {
  approve(): void;
  cancel(): void;
  modify(change: ModifyChange): Promise<Allocation>;
}

export interface ComparisonPageProps {
  readonly orchestrator: ComparisonOrchestrator;
  /** Fallback allocation when the store has none yet (e.g. server-driven preview). */
  readonly allocation?: Allocation;
  /** Injectable text-to-speech for "read back"; defaults to a no-op (no native TTS in tests/web). */
  readonly speak?: (text: string) => void;
}

const noopSpeak = (): void => {};

/** Pick the "other" platform to swap a line to (2-platform MVP; generalises to N). */
function otherPlatform(current: PlatformId): PlatformId | undefined {
  return SUPPORTED_PLATFORMS.find((p) => p !== current);
}

export function ComparisonPage({
  orchestrator,
  allocation: fallbackAllocation,
  speak = noopSpeak,
}: ComparisonPageProps): JSX.Element {
  const subscribe = useCallback(
    (cb: () => void) => orchestrator.subscribe(cb),
    [orchestrator],
  );
  const getSnapshot = useCallback(() => orchestrator.getState(), [orchestrator]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const [editing, setEditing] = useState(false);

  const allocation = state.allocation ?? fallbackAllocation ?? null;
  const explanation = useMemo(
    () => (allocation ? explainAllocation(allocation) : ""),
    [allocation],
  );

  const busy = state.status === "optimizing" || state.status === "modifying";
  const decided =
    state.status === "approved" ||
    state.status === "cancelled" ||
    state.status === "executing" ||
    state.status === "needs_otp" ||
    state.status === "needs_payment" ||
    state.status === "placing" ||
    state.status === "done";

  /** Current demand qty for an item name (so the stepper edits total demand, not a partial line). */
  const demandQty = useCallback(
    (itemName: string): number => {
      const item = state.items.find((i) => i.name === itemName);
      return item?.qty ?? 0;
    },
    [state.items],
  );

  const handleProceed = useCallback(() => {
    orchestrator.approve();
  }, [orchestrator]);

  const handleCancel = useCallback(() => {
    orchestrator.cancel();
  }, [orchestrator]);

  const handleReadBack = useCallback(() => {
    if (explanation) {
      speak(explanation);
    }
  }, [explanation, speak]);

  const handleQtyDelta = useCallback(
    (line: AllocationLine, delta: number) => {
      const next = Math.max(0, demandQty(line.itemName) + delta);
      void orchestrator.modify({
        kind: "change-qty",
        itemName: line.itemName,
        qty: next,
      });
    },
    [demandQty, orchestrator],
  );

  const handleSwap = useCallback(
    (line: AllocationLine) => {
      const target = otherPlatform(line.platform);
      if (!target) {
        return;
      }
      void orchestrator.modify({
        kind: "swap-platform",
        canonicalItemId: line.canonicalItemId,
        itemName: line.itemName,
        platform: target,
      });
    },
    [orchestrator],
  );

  const handleDrop = useCallback(
    (line: AllocationLine) => {
      void orchestrator.modify({ kind: "drop-item", itemName: line.itemName });
    },
    [orchestrator],
  );

  const renderLineControls = useCallback(
    (line: AllocationLine) => {
      if (!editing || decided) {
        return null;
      }
      const swapTarget = otherPlatform(line.platform);
      return (
        <IonButtons>
          <IonButton
            data-testid={`qty-dec-${line.canonicalItemId}`}
            aria-label={`decrease ${line.itemName}`}
            onClick={() => handleQtyDelta(line, -1)}
          >
            −
          </IonButton>
          <IonButton
            data-testid={`qty-inc-${line.canonicalItemId}`}
            aria-label={`increase ${line.itemName}`}
            onClick={() => handleQtyDelta(line, 1)}
          >
            +
          </IonButton>
          {swapTarget ? (
            <IonButton
              data-testid={`swap-${line.canonicalItemId}`}
              aria-label={`move ${line.itemName} to ${swapTarget}`}
              onClick={() => handleSwap(line)}
            >
              Move to {swapTarget}
            </IonButton>
          ) : null}
          <IonButton
            data-testid={`drop-${line.canonicalItemId}`}
            aria-label={`drop ${line.itemName}`}
            color="danger"
            onClick={() => handleDrop(line)}
          >
            Drop
          </IonButton>
        </IonButtons>
      );
    },
    [decided, editing, handleDrop, handleQtyDelta, handleSwap],
  );

  const savingPaise = allocation?.savingPaise ?? 0;
  const saved = savingPaise < 0;

  return (
    <IonPage>
      <BrandHeader title="Review your order" subtitle="Approve to place — nothing buys yet" />
      <IonContent className="ion-padding pc-content">
        {busy ? (
          <div className="pc-banner pc-banner--info" data-testid="optimizing-indicator">
            <IonSpinner name="dots" aria-label="optimizing" />
            <IonNote>Re-optimizing…</IonNote>
          </div>
        ) : null}

        {allocation ? (
          <>
            {saved ? (
              <div className="pc-savings-hero">
                <p className="pc-savings-hero__label">You save</p>
                <p className="pc-savings-hero__amount">{formatRupees(-savingPaise)}</p>
                <p className="pc-savings-hero__sub">
                  vs buying everything on one platform (
                  {formatRupees(allocation.singlePlatformBaselinePaise)})
                </p>
              </div>
            ) : (
              <div className="pc-savings-hero pc-savings-hero--flat">
                <p className="pc-savings-hero__label">Order total</p>
                <p className="pc-savings-hero__amount">
                  {formatRupees(allocation.grandTotalPaise)}
                </p>
                <p className="pc-savings-hero__sub">Best available split across platforms</p>
              </div>
            )}

            <AllocationCard
              allocation={allocation}
              renderLineControls={renderLineControls}
            />

            <div className="pc-card">
              <div className="pc-card__head">
                <span className="pc-platform__name" style={{ fontSize: "1rem" }}>
                  What this means
                </span>
                <IonButton
                  data-testid="readback-button"
                  fill="clear"
                  size="small"
                  onClick={handleReadBack}
                >
                  🔊 Read back
                </IonButton>
              </div>
              <div className="pc-card__body">
                <pre
                  data-testid="explanation"
                  style={{
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    margin: 0,
                    lineHeight: 1.5,
                    color: "var(--ion-text-color)",
                  }}
                >
                  {explanation}
                </pre>
              </div>
            </div>

            {state.status === "approved" ? (
              <IonText color="success" role="status" data-testid="approved-note">
                <p className="pc-banner pc-banner--success">
                  Approved — preparing your carts. We&apos;ll pause for OTP/payment.
                </p>
              </IonText>
            ) : null}

            {state.status === "cancelled" ? (
              <IonText color="medium" role="status" data-testid="cancelled-note">
                <p className="pc-banner pc-banner--info">
                  Order cancelled. Nothing was purchased.
                </p>
              </IonText>
            ) : null}
          </>
        ) : (
          <IonText color="medium" data-testid="no-allocation">
            <p>Working out the best split…</p>
          </IonText>
        )}
      </IonContent>

      {allocation && !decided ? (
        <IonFooter className="ion-no-border">
          <div className="pc-sticky-bar">
            <IonButton
              className="pc-cta"
              data-testid="proceed-button"
              expand="block"
              onClick={handleProceed}
            >
              Proceed
            </IonButton>
            <div className="pc-sticky-bar__row">
              <IonButton
                data-testid="modify-button"
                fill="outline"
                aria-pressed={editing}
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? "Done editing" : "Modify"}
              </IonButton>
              <IonButton
                data-testid="cancel-button"
                fill="outline"
                color="danger"
                onClick={handleCancel}
              >
                Cancel
              </IonButton>
            </div>
          </div>
        </IonFooter>
      ) : null}
    </IonPage>
  );
}

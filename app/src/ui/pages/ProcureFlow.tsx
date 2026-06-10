/**
 * The end-to-end MVP flow controller (PROCURE_COPILOT_PLAN.md §6, §3.6). It is the on-device glue
 * that ties every epic together behind the single {@link Orchestrator} state machine:
 *
 *   Chat (Epic 1) → collect quotes via per-platform WebView engines (Epic 2/3) → optimize (Epic 4)
 *   → Comparison + approval (Epic 5) → per-platform checkout with Verifier + OTP/payment hand-off
 *   and audit (Epic 6) → Order summary.
 *
 * The UX binds to the orchestrator's observable store (live, no polling); automation events are folded
 * back in via `orchestrator.ingest`. Nothing irreversible runs without the explicit approval gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IonButton, IonContent, IonPage, IonSpinner } from "@ionic/react";
import type { OrderAttempt, PlatformId, RequestedItem } from "../../core/domain/types";
import type { BackendClient } from "../../core/backend/BackendClient";
import { HttpBackendClient } from "../../core/backend/BackendClient";
import { IntentClient } from "../../core/intent/IntentClient";
import { Orchestrator } from "../../core/orchestrator/Orchestrator";
import { CapgoBridge } from "../../core/automation/bridge";
import type { InAppBrowserBridge } from "../../core/automation/bridge";
import type { AutomationEngine } from "../../core/automation/AutomationEngine";
import { MockAutomationEngine } from "../../core/automation/__mocks__/MockAutomationEngine";
import { createEngine } from "../../core/adapters";
import { CheckoutDriver } from "../../core/checkout/CheckoutDriver";
import { AuditLog } from "../../core/audit/AuditLog";
import { InMemorySecureStore } from "../../core/secure/SecureStore";
import type { DomainEvent } from "../../core/automation/events";
import { BACKEND_BASE_URLS, PLATFORM_URLS } from "../../core/config";
import { isAutomationDebug, traceAutomation } from "../../core/debug/automationDebug";
import { useSyncExternalStore } from "react";
import { ChatPage } from "./ChatPage";
import { ComparisonPage } from "./ComparisonPage";
import { OtpPaymentPage } from "./OtpPaymentPage";
import { OrderSummaryPage } from "./OrderSummaryPage";
import { BrandHeader } from "../components/BrandHeader";
import { AutomationDebugOverlay } from "../components/AutomationDebugOverlay";

interface PendingHitl {
  readonly platform: PlatformId;
  readonly kind: "otp" | "payment";
  readonly prompt: string;
  readonly amountPaise?: number;
}

const QUOTE_PLATFORMS: readonly PlatformId[] = ["hyperpure", "amazon"];

/** Branded full-screen loading state with step text, platform pills, and skeleton placeholders. */
function Busy({
  message,
  title = "Working on your order",
  showPlatforms = false,
  showSkeletons = false,
}: {
  message: string;
  title?: string;
  showPlatforms?: boolean;
  showSkeletons?: boolean;
}): JSX.Element {
  return (
    <IonPage>
      <BrandHeader title="Procure Copilot" subtitle="Save ₹ on every order" />
      <IonContent className="ion-padding pc-content">
        <div className="pc-loading">
          <IonSpinner name="crescent" className="pc-loading__spinner" />
          <div>
            <p className="pc-loading__title">{title}</p>
            <p className="pc-loading__step">{message}</p>
          </div>
          {showPlatforms ? (
            <div className="pc-loading__platforms">
              <span className="pc-platform-pill pc-platform-pill--hyperpure">
                <span className="pc-platform__dot" />
                Hyperpure
              </span>
              <span className="pc-platform-pill pc-platform-pill--amazon">
                <span className="pc-platform__dot" />
                Amazon.in
              </span>
            </div>
          ) : null}
        </div>
        {showSkeletons ? (
          <div aria-hidden="true">
            <div className="pc-skeleton pc-skeleton-card" />
            <div className="pc-skeleton pc-skeleton-card" />
          </div>
        ) : null}
      </IonContent>
    </IonPage>
  );
}

/** Branded terminal failure state with a retry that restarts the flow. */
function FailedState({ message }: { message: string }): JSX.Element {
  return (
    <IonPage>
      <BrandHeader title="Procure Copilot" subtitle="Something needs attention" />
      <IonContent className="ion-padding pc-content">
        <div className="pc-handoff-card">
          <span
            className="pc-handoff-card__icon"
            style={{
              background: "rgba(var(--ion-color-danger-rgb), 0.12)",
              color: "var(--ion-color-danger)",
            }}
            aria-hidden="true"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 8v5M12 16.5v.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <h2 className="pc-handoff-card__platform">We hit a snag</h2>
          <p className="pc-handoff-card__prompt" role="alert">
            {message}
          </p>
        </div>
        <div className="pc-section">
          <IonButton
            className="pc-cta"
            expand="block"
            onClick={() => window.location.assign("/")}
          >
            Start over
          </IonButton>
        </div>
      </IonContent>
    </IonPage>
  );
}

/** Factory matching {@link createEngine}; injectable so demo/e2e can supply a deterministic engine. */
export type CreateEngineImpl = (
  platform: PlatformId,
  bridge: InAppBrowserBridge,
  backend: BackendClient,
) => AutomationEngine;

export interface ProcureFlowProps {
  /** Inject the backend client (e.g. a fake); defaults to the real HTTP client. */
  readonly backend?: BackendClient;
  /** Inject the orchestrator; defaults to one wrapping `backend`. */
  readonly orchestrator?: Orchestrator;
  /** Inject the automation-engine factory; defaults to the real `createEngine` (or the demo mock). */
  readonly createEngineImpl?: CreateEngineImpl;
  /** Inject the WebView bridge factory; defaults to the real Capgo bridge. */
  readonly bridgeImpl?: () => InAppBrowserBridge;
  /**
   * Force demo mode on/off. When omitted it is read from an explicit, production-impossible signal
   * (`?demo=1` on the URL, or `VITE_DEMO=1`); production `/flow` never triggers it.
   */
  readonly demo?: boolean;
}

/**
 * Detect the opt-in demo seam. It can ONLY be turned on by an explicit signal that never appears in a
 * production build/visit: the `?demo=1` query param or the `VITE_DEMO=1` env flag. Without it the
 * controller behaves byte-for-byte as before (real Capgo WebView engines).
 */
function detectDemoMode(): boolean {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("demo") === "1") {
        return true;
      }
    }
  } catch {
    // No DOM (SSR/tests) — fall through to the env flag.
  }
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return env.VITE_DEMO === "1";
}

/**
 * The flow controller. Dependencies are injectable for testing; on a device it constructs an
 * HTTP-backed client, an orchestrator, an on-device audit log, and a Capgo WebView bridge.
 *
 * In demo mode (see {@link detectDemoMode}) the automation transport is swapped for a deterministic
 * {@link MockAutomationEngine} so the full journey runs in a plain browser. Nothing else changes —
 * the orchestrator state machine, the checkout driver, the Verifier safety gate, and the live
 * backend calls all run exactly as in production.
 */
export function ProcureFlow(props: ProcureFlowProps = {}): JSX.Element {
  const isDemo = useMemo(() => props.demo ?? detectDemoMode(), [props.demo]);

  const backend = useMemo(
    () => props.backend ?? new HttpBackendClient(BACKEND_BASE_URLS),
    [props.backend],
  );
  const orchestrator = useMemo(
    () => props.orchestrator ?? new Orchestrator(backend),
    [props.orchestrator, backend],
  );
  const intentClient = useMemo(() => new IntentClient(backend), [backend]);
  const audit = useMemo(() => new AuditLog(new InMemorySecureStore()), []);

  const bridgeRef = useRef<InAppBrowserBridge | null>(null);
  const enginesRef = useRef<Map<PlatformId, AutomationEngine>>(new Map());
  const humanResolverRef = useRef<(() => void) | null>(null);
  const checkoutStartedRef = useRef(false);

  const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [attempts, setAttempts] = useState<OrderAttempt[]>([]);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);

  const state = useSyncExternalStore(orchestrator.subscribe, orchestrator.getState);

  const bridge = useCallback((): InAppBrowserBridge => {
    if (bridgeRef.current === null) {
      bridgeRef.current = props.bridgeImpl ? props.bridgeImpl() : new CapgoBridge();
    }
    return bridgeRef.current;
  }, [props.bridgeImpl]);

  // The engine factory: an explicit injected factory wins; otherwise demo mode uses the deterministic
  // in-memory mock (no WebView/bridge), and production uses the real Capgo-backed `createEngine`.
  const makeEngine = useCallback(
    (platform: PlatformId): AutomationEngine => {
      if (props.createEngineImpl) {
        return props.createEngineImpl(platform, bridge(), backend);
      }
      if (isDemo) {
        return new MockAutomationEngine({
          platform,
          getAllocation: () => orchestrator.getState().allocation,
        });
      }
      // Give SPA listings a few seconds to lazy-load priced tiles before readProduct extracts.
      return createEngine(platform, bridge(), backend, { listingSettleMs: 8000 });
    },
    [props.createEngineImpl, isDemo, backend, bridge, orchestrator],
  );

  const engineFor = useCallback(
    (platform: PlatformId): AutomationEngine => {
      const existing = enginesRef.current.get(platform);
      if (existing) {
        return existing;
      }
      const engine = makeEngine(platform);
      enginesRef.current.set(platform, engine);
      return engine;
    },
    [makeEngine],
  );

  // ---- Phase 1: parse confirmed → collect quotes on each platform → optimize ----
  const startProcurement = useCallback(
    async (items: readonly RequestedItem[]) => {
      const request = {
        id: crypto.randomUUID(),
        items,
        createdAt: new Date().toISOString(),
      };
      setBusyMessage("Planning your order…");
      await orchestrator.start(request);

      setBusyMessage("Checking prices on Hyperpure and Amazon…");
      // In automation-debug mode show the live WebView so you can watch the scrape; otherwise hidden.
      const showWebView = isAutomationDebug();
      const br = bridge();

      let quotesCollected = 0;
      for (const platform of QUOTE_PLATFORMS) {
        try {
          const engine = engineFor(platform);
          traceAutomation("think", `opening ${PLATFORM_URLS[platform]}`, platform);
          await engine.open(PLATFORM_URLS[platform], { hidden: !showWebView });

          // Sign-in only when the page actually shows a login wall — so we don't re-prompt when the
          // device is already logged in, and don't open the WebView twice unnecessarily. Many
          // platforms (esp. Hyperpure) gate catalog/pricing behind login + a serviceable area.
          if (showWebView && br.openLoginSession && engine.detectLoginWall) {
            let needLogin = false;
            try {
              needLogin = (await engine.detectLoginWall?.()) ?? false;
            } catch {
              needLogin = false;
            }
            if (needLogin) {
              setBusyMessage(
                `Sign in to ${platform}: log in + set your delivery location, then close the window…`,
              );
              traceAutomation(
                "think",
                "not logged in → opening sign-in window; log in + set location, then close it to continue",
                platform,
              );
              try {
                await engine.close();
              } catch {
                /* ignore */
              }
              try {
                await br.openLoginSession?.(platform, PLATFORM_URLS[platform]);
              } catch (err) {
                traceAutomation(
                  "warn",
                  `sign-in hand-off skipped: ${err instanceof Error ? err.message : String(err)}`,
                  platform,
                );
              }
              traceAutomation("think", "re-opening after sign-in", platform);
              await engine.open(PLATFORM_URLS[platform], { hidden: !showWebView });
            } else {
              traceAutomation("info", "session already authenticated → skipping sign-in", platform);
            }
          }

          setBusyMessage("Checking prices on Hyperpure and Amazon…");
          for (const item of orchestrator.getState().items) {
            try {
              await engine.search(item);
              const quote = await engine.readProduct(item);
              orchestrator.recordQuote(quote);
              quotesCollected += 1;
              traceAutomation(
                "info",
                `✓ "${item.name}" → ₹${(quote.pricePaise / 100).toFixed(2)} inStock=${quote.inStock}`,
                platform,
              );
            } catch (err) {
              // Skip items this platform can't quote; the optimizer handles partial availability.
              traceAutomation(
                "error",
                `✗ "${item.name}": ${err instanceof Error ? err.message : String(err)}`,
                platform,
              );
            }
          }
          // Hide the visible WebView between platforms so the trace/comparison stays readable.
          if (showWebView) {
            try {
              await engine.hide();
            } catch {
              /* best-effort */
            }
          }
        } catch (err) {
          // Platform unreachable / not logged in — proceed with whatever quotes we have.
          traceAutomation(
            "error",
            `unreachable (open/login failed): ${err instanceof Error ? err.message : String(err)}`,
            platform,
          );
        }
      }
      traceAutomation(
        quotesCollected > 0 ? "info" : "warn",
        `collected ${quotesCollected} quote(s) across ${QUOTE_PLATFORMS.length} platform(s)`,
      );

      setBusyMessage("Finding the cheapest split…");
      await orchestrator.optimize();
      traceAutomation("think", "optimization complete");
      setBusyMessage(null);
    },
    [engineFor, orchestrator],
  );

  // ---- Phase 2 (after explicit approval): drive checkout per platform ----
  const runCheckout = useCallback(async () => {
    const allocation = orchestrator.getState().allocation;
    if (!allocation) {
      return;
    }
    const onEvent = (event: DomainEvent): void => {
      orchestrator.ingest(event);
      if (event.type === "NeedsOtp") {
        setRevealed(false);
        setPendingHitl({ platform: event.platform, kind: "otp", prompt: event.prompt });
      } else if (event.type === "NeedsPayment") {
        setRevealed(false);
        setPendingHitl({
          platform: event.platform,
          kind: "payment",
          prompt: event.prompt,
          amountPaise: event.amountPaise,
        });
      }
    };
    const awaitHuman = (): Promise<void> =>
      new Promise<void>((resolve) => {
        humanResolverRef.current = resolve;
      });

    const collected: OrderAttempt[] = [];
    for (const platformAllocation of allocation.perPlatform) {
      if (platformAllocation.lines.length === 0) {
        continue;
      }
      const engine = engineFor(platformAllocation.platform);
      const driver = new CheckoutDriver({ engine, backend, audit, onEvent, awaitHuman });
      try {
        const attempt = await driver.run(platformAllocation);
        collected.push(attempt);
      } catch {
        // The driver already emitted StepFailed; keep going with other platforms.
      }
    }
    setAttempts(collected);
    setPendingHitl(null);
  }, [audit, backend, engineFor, orchestrator]);

  useEffect(() => {
    if (state.status === "approved" && !checkoutStartedRef.current) {
      checkoutStartedRef.current = true;
      void runCheckout();
    }
  }, [state.status, runCheckout]);

  // ---- Render by session status (and the HITL hand-off, which preempts everything) ----
  const content = renderContent();
  return (
    <>
      {content}
      {isAutomationDebug() ? <AutomationDebugOverlay /> : null}
    </>
  );

  function renderContent(): JSX.Element {
  if (pendingHitl) {
    return (
      <OtpPaymentPage
        platform={pendingHitl.platform}
        kind={pendingHitl.kind}
        prompt={pendingHitl.prompt}
        amountPaise={pendingHitl.amountPaise}
        revealed={revealed}
        onReveal={() => {
          void enginesRef.current.get(pendingHitl.platform)?.show();
          setRevealed(true);
        }}
        onDone={() => {
          const resolve = humanResolverRef.current;
          humanResolverRef.current = null;
          setPendingHitl(null);
          setRevealed(false);
          resolve?.();
        }}
      />
    );
  }

  if (busyMessage) {
    return (
      <Busy
        message={busyMessage}
        title="Finding your best price"
        showPlatforms
        showSkeletons
      />
    );
  }

  switch (state.status) {
    case "awaiting_approval":
    case "modifying":
      return <ComparisonPage orchestrator={orchestrator} />;
    case "planning":
    case "quoting":
    case "optimizing":
      return (
        <Busy
          message="Checking prices on Hyperpure and Amazon…"
          title="Finding your best price"
          showPlatforms
          showSkeletons
        />
      );
    case "approved":
    case "executing":
    case "placing":
      return (
        <Busy message="Filling your carts — we'll pause for OTP/payment." title="Placing your orders" />
      );
    case "done":
      return <OrderSummaryPage attempts={attempts} />;
    case "failed":
      return <FailedState message={state.error ?? "Something went wrong. Please try again."} />;
    case "cancelled":
      return (
        <ChatPage
          intentClient={intentClient}
          onConfirm={(items) => void startProcurement(items)}
        />
      );
    case "idle":
    default:
      return (
        <ChatPage
          intentClient={intentClient}
          onConfirm={(items) => void startProcurement(items)}
        />
      );
  }
  }
}

---
title: Per-platform agents + guided RAG
todos:
  - content: "Phase 1 — Per-platform agent seam (PlatformAgent / BrowserSession / AgentRegistry / LegacyAgent)"
    status: completed
  - content: "Phase 2 — AmazonAgent: detail-page true-price read, ASIN extraction, native add-to-cart with added/failed confirmation"
    status: completed
  - content: "Phase 3 — HyperpureAgent: direct results-URL search + detail-page add with ADD→stepper / cart-count confirmation and honest failed hand-off"
    status: completed
  - content: "Phase 4 — Pricing: pack-price normalisation, quantity reconciliation (ceil(total/packSize)), best-value default pins, wired through the Orchestrator"
    status: completed
  - content: "Phase 5 — Guided-RAG knowledge layer (curated per-platform policies/hints + backend transport) — guided hints DONE; persistent on-device learning pipeline PENDING"
    status: in_progress
  - content: "Phase 6 — First-run login gate, cart hand-off (stageCart + OrderSummary links), and opt-in debug tracing incl. backend/LLM calls"
    status: completed
  - content: "Disable Amazon by default (AWS-WAF bot-wall) via ACTIVE_PLATFORMS while retaining the AmazonAgent for re-enablement"
    status: completed
  - content: "Candidate / nearby-product selection UI"
    status: pending
  - content: "Continuous RAG learning loop (fold recorded observations back into extraction automatically)"
    status: pending
---

# Per-platform agents + guided RAG

This plan splits the single shared Amazon/Hyperpure automation path into **per-platform agents**, fixes
the divergent price/add bugs each platform had, and layers a **guided-knowledge (RAG)** seam plus the
first-run login gate, cart hand-off, and debug tracing on top. It complements the MVP plan in
[`PROCURE_COPILOT_PLAN.md`](../../PROCURE_COPILOT_PLAN.md) (Epics 0–6).

## Implementation status

**Done (Phases 1–4 and 6):**

- **Per-platform agent seam** — `app/src/core/agents/`: `PlatformAgent` contract
  (`ensureReady`/`search`/`readQuote`/`addToCart` → `AddToCartResult {status:"added"|"failed", productUrl?,
  cartUrl?, reason?}`), `BrowserSession` (extends `AutomationEngine` with `observe`/`act`/`captureScreenshot`),
  `AgentRegistry` (`agentFor`/`agentForEngine`), and the behavior-neutral `LegacyAgent` (demo mock path).
- **Amazon** — `amazon/AmazonAgent.ts` + `selectors.ts` + `detailExtract.ts`: reads the **true detail-page
  buybox price** (fixes the listing ₹99-vs-real-₹237 bug), extracts the ASIN for a canonical `/dp/<ASIN>`
  URL, and does a native add-to-cart with added/failed confirmation. **Amazon is disabled by default**
  (`ACTIVE_PLATFORMS` in `config.ts`; AWS-WAF bot-challenge won't run in the WebView) — code retained.
- **Hyperpure** — `hyperpure/HyperpureAgent.ts` + `selectors.ts`: SEARCH navigates straight to the
  deterministic results URL (`hyperpureSearchUrl`), ADD opens the detail page (`hyperpureProductUrl`),
  clicks ADD and **confirms** via the ADD→stepper swap or a cart-count rise (`addLooksConfirmed`), falling
  back to the listing and returning `failed` + a product link for an honest manual hand-off.
- **Pricing** — `pricing/packPricing.ts` (₹/kg·L·piece), `pricing/quantityReconcile.ts`
  (`ceil(totalRequested / soldPackSize)`), `optimizer/defaultSelection.ts` (lowest-per-unit default pins),
  wired through `Orchestrator.optimize` (locked by `quantityReconcile.test.ts`).
- **Login gate + hand-off + debug** — `auth/loginStore.ts` + `ui/pages/LoginGate.tsx` (per-platform boolean
  only); `checkout/CheckoutDriver.stageCart` + `OrderSummaryPage` ("Added" / "Couldn't add — open product" /
  "Review & checkout"); `debug/automationDebug.ts` overlay tracing every step **and every backend/LLM call**
  (`BackendClient`, `backend` channel) plus injected `[hpinj]` diagnostics, with console noise filtered.

**Partial (Phase 5 — guided RAG):**

- The curated per-platform **knowledge/hints layer** is implemented — `knowledge/PlatformKnowledge.ts`,
  `DefaultKnowledgeStore` (`getKnowledge` + `recordObservation`), built-in `defaults.ts`, and the backend
  `KnowledgeController`/`KnowledgeService` — and agents consume the policies/hints (e.g.
  `priceFromDetailPage`, `atcTokens`). It **guides, never gates** (safe offline defaults).
- **Pending:** the persistent on-device learning pipeline. `recordObservation` exists but is not yet wired
  to learn from screenshots/DOM during live runs, and observations are not folded back into extraction
  automatically.

**Pending overall:**

- Candidate / nearby-product **selection UI** (let the user pick among close matches).
- **Continuous RAG learning** (observations → curated hints, shadow-mode promotion).

## Phases

### Phase 1 — Agent seam (done)
Introduce the `PlatformAgent`/`BrowserSession` contract additively; `LegacyAgent` delegates to the engine
so behavior is unchanged until real agents land. `AgentRegistry.agentForEngine` returns the dedicated agent
for real WebView engines and `LegacyAgent` for the demo mock.

### Phase 2 — AmazonAgent (done)
Detail-page true-price read (`detailExtract.ts` buybox heuristics), ASIN extraction, native add-to-cart
with confirmation. Disabled by default behind `ACTIVE_PLATFORMS` (AWS-WAF), retained for re-enablement.

### Phase 3 — HyperpureAgent (done)
Direct results-URL search (no synthetic-Enter autosuggest race) and detail-page add with explicit
add/confirm and an honest failed hand-off.

### Phase 4 — Pricing reconciliation (done)
Quantity reconciliation and best-value default pins so the comparison UI and staged cart use correct
counts and the genuinely cheapest per-unit option.

### Phase 5 — Guided RAG (partial)
Curated per-platform policies/hints implemented and consumed by agents; continuous on-device learning
pipeline pending.

### Phase 6 — Login gate, hand-off, debug (done)
First-run manual sign-in gate, cart hand-off summary, and opt-in debug tracing (including backend/LLM calls).

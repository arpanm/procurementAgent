# Procure Copilot — Mobile Agentic Procurement Assistant

**Working codename:** Procure Copilot
**Slots into:** ShopOS / NAM **Procurement Agent** as its on-device execution layer
**Target user:** Indian retailers & restaurant owners (kirana, HoReCa) who already buy on B2B platforms
**Doc owner:** Arpan • **Status:** v0.3 engineering plan for quick MVP
**Scope (this plan):** **Amazon.in + Hyperpure only.** Everything else is designed-for but not built.
**See also:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — how the system works today (diagrams, flowcharts, code links) • [`README.md`](./README.md) — build/run.

**Resolved decisions (MVP):**
- **App shell:** **Capacitor (Ionic) + Capgo `@capgo/capacitor-inappbrowser`** for the automation engine; automation kept behind a clean interface so a native Android plugin can replace it later if a site forces it.
- **LLM:** a single **strong Anthropic Claude model** for all reasoning (no cheap/planner tiering in MVP).
- **Platform:** **Android only.**
- **Backend:** **Spring Boot backend is part of MVP** (acceptable per latest direction). It hosts the Anthropic proxy (key off-device), the agent "brain" endpoints (plan / next-action / verify), the playbook registry with remote push, the optimizer, the eval harness, and the telemetry sink. The device runs the webviews and the perceive→act loop; the backend runs the reasoning and shared services.

---

## 0. Implementation status (current vs this plan)

> This section records where the code has diverged from / advanced beyond the original plan. The Epic
> annotations in §8 carry the detail. The plan's forward-looking content is intentionally kept.

- **Per-platform agents (new layer).** Amazon and Hyperpure no longer share one playbook/selector path.
  `app/src/core/agents/` adds a `PlatformAgent` strategy contract (`ensureReady`/`search`/`readQuote`/
  `addToCart`) over a `BrowserSession`, resolved by `AgentRegistry`. This refines the single-`PlatformAdapter`
  idea of §3.1 into per-platform strategies while keeping the orchestrator decoupled.
- **Active platforms: Hyperpure live, Amazon disabled.** Amazon's mobile site serves an AWS-WAF
  bot-challenge that won't execute in the WebView (`AwsWafIntegration is not defined`, blank page, 0
  elements). `ACTIVE_PLATFORMS` (`config.ts`, override `VITE_ACTIVE_PLATFORMS`) currently lists only
  `hyperpure`; the `AmazonAgent` is retained for one-line re-enablement.
- **Checkout reality = cart hand-off (not auto-place).** The live flow uses `CheckoutDriver.stageCart`:
  best-effort add each line, then hand the user a "Review & checkout on {platform}" cart link and a
  per-item "open to add manually" link for anything it couldn't add. The fully-automated `run()` path
  (Verifier → checkout → OTP/payment HITL → place) exists and is tested, but is not what `ProcureFlow` runs.
- **True prices + quantity reconciliation.** Amazon reads the detail-page buybox price (not the noisy
  listing); per-line quantities are reconciled to each platform's sold pack size (`ceil(total / packSize)`);
  the default per-item pick is the lowest ₹ per kg/L/piece.
- **Guided-RAG knowledge + durable site memory (two layers).** (1) A curated per-platform policies/hints
  layer (`knowledge/` + backend `/knowledge`) consumed by agents. (2) An on-device **`SiteMemory`**
  (`knowledge/siteMemory.ts` + `signature.ts`, localStorage) that learns durable product URLs and element
  signatures (search box, product card, ADD button — tag/role/name/attrs/bbox) from successful runs and
  tries them before vision/Claude. Wired into `HyperpureAgent` (`learnFromAdd`/`recallProductUrl`/
  `matchSignature`). The *continuous* learning pipeline that folds observations back into extraction
  automatically is still **pending** (notes are advisory today).
- **Candidate / nearby-SKU picker (new).** The vision read returns a **ranked top-N** of candidates per
  platform (`/vision/extract` → `candidates[]`); the device classifies each as `exact`/`nearby`
  (`pricing/matchKind.ts`) and auto-picks the cheapest exact ₹/unit. When the default pick is only a
  `nearby` match, `ComparisonPage` shows an inline "choose a nearby SKU" picker (`select-sku` modify →
  re-optimize) so the user picks without leaving the app.
- **First-run login gate + opt-in debug tracing** are implemented (see Epics 0/6 and §3.5).
- **Reliability guardrails (new).** Self-explanatory Claude HTTP errors + a boot-time
  `AnthropicStartupProbe` (catches a retired model id loudly); webview `open()` close-then-reopen (fixes
  stacked webviews + the stranded-settle timeout); outbox drops permanent `4xx` (`BackendHttpError`) instead
  of retry storms; failed adds hand back an honest search URL.

**Pending / not yet built:** continuous RAG learning loop, CP-SAT optimizer (greedy ships), the replayable
golden-path eval harness / playbook shadow-mode promotion, and re-enabling Amazon once the WAF challenge is
solved. (The candidate/nearby-product picker, previously pending, is now implemented.)

---

## 1. What we are building (scope)

A mobile (Android-first) AI assistant that lets a retailer say or type *"order 10kg onions, 5kg paneer, 2 cartons of refined oil"* and then autonomously:

1. Understands the request (chat or voice, Hindi/Bengali/English mixed register).
2. Opens each B2B platform in a controlled WebView — **Hyperpure and Amazon.in**.
3. Searches each SKU, reads **price + availability + delivery date + MOV/credit**.
4. Runs a **cart-split optimizer** that allocates each item to the platform that minimises total landed cost subject to availability, minimum-order-value, delivery-fee and credit constraints.
5. Shows the proposed split in plain language and rupees ("Onions cheaper on Hyperpure by ₹38, oil cheaper on Amazon — total saving ₹214"). Asks **proceed / modify**.
6. On approval, adds items to each platform's cart, proceeds to checkout, and **places the order if credit is available**; otherwise pauses and asks the retailer to complete payment.
7. Hands control to the human for **OTP entry** and **payment** — never automates these.

### We are building the automation engine ourselves
Procure Copilot **is** the browser/app-automation agent — an OpenClaw/Cowork-style capability that we own and control end-to-end, not a wrapper around any external agent runtime. The same engine that drives a WebView today is the foundation for driving other apps/sites later.

### Explicit non-goals (this plan)
- **Only Amazon.in and Hyperpure.** No Udaan, Metro, Jumbotail, or any native-app control in this plan.
- **No on-device / edge LLM.** All reasoning runs on **Anthropic (Claude) via API**.
- **No external agent runtimes.** Not integrating OpenClaw or Claude Cowork; we build the equivalent.
- **No automated payment or OTP entry.** Human-in-the-loop only.
- **No credential scraping / bot farms.** The agent operates **the retailer's own authenticated session, on the retailer's own device, with per-action consent.**

### Designed-for, not built (extensibility — see §10)
Additional web platforms (e.g. Udaan), native-app-only platforms via Accessibility Service (e.g. Metro, Jumbotail), and official partner REST APIs are all enabled by the adapter interface (§3.1) but are out of scope here.

---

## 2. Strategic & legal risk — read this first

This is the single biggest determinant of viability, so it leads the plan.

- **ToS / anti-automation.** Amazon and Zomato/Hyperpure ToS generally prohibit automated interaction. The defensible posture is: (a) the user acts through their **own** logged-in session on their **own** device, (b) **every order is human-confirmed**, (c) we never crawl beyond what the user asked for, (d) we throttle to human-like pacing. This is "assistive automation for the account owner," not scraping.
- **Preferred future path: partner APIs.** Given the Reliance/JioMart/Fynd relationships, official B2B ordering APIs are the highest-leverage long-term move. The adapter interface is built so a WebView-backed platform can later be swapped for an API-backed one with no change to the agent core. WebView automation is the bridge for platforms that don't expose an API.
- **Payments & PCI.** We never touch card data. Payment always happens inside the platform's own checkout UI, driven by the human. We only detect "payment required" vs "paid on credit."
- **Data protection (DPDP Act).** Retailer credentials, session cookies, OTPs and order history are sensitive. Stored on-device only (Android Keystore + EncryptedSharedPreferences / SQLCipher). Secrets (credentials, OTPs) are scrubbed before anything is sent to the Anthropic API or to logs.

---

## 3. Architecture

### 3.1 Layered view

```
┌─────────────────────────────────────────────────────────────┐
│  Conversation Layer  (chat + voice, vernacular)             │
│   • STT • TTS • intent + slot extraction (Claude API)       │
├─────────────────────────────────────────────────────────────┤
│  Orchestrator / Agent Core  (Planner–Executor–Verifier)     │
│   • plan procurement • drive adapters • HITL gates          │
├─────────────────────────────────────────────────────────────┤
│  Comparison & Optimization Engine                           │
│   • normalise SKUs • cart-split MILP/heuristic              │
├─────────────────────────────────────────────────────────────┤
│  WebView Adapter   (Hyperpure, Amazon.in)                   │
│   the automation engine we own                              │
├─────────────────────────────────────────────────────────────┤
│  Platform Abstraction Interface  (same contract for all)    │
│   search() • getProduct() • addToCart() • getCart() •       │
│   checkout() • orderStatus() • needsOtp() • needsPayment()  │
├─────────────────────────────────────────────────────────────┤
│  Secure State  (Keystore, encrypted session store, audit)   │
└─────────────────────────────────────────────────────────────┘
```

Key design idea: **one `PlatformAdapter` interface; today one implementation (WebView).** The orchestrator never knows how an adapter fulfils a request, so future implementations (other web sites, native-app via Accessibility, REST API) drop in without touching the core. That single seam is what makes the whole thing extensible.

### 3.2 All reasoning via Anthropic API

There is no edge LLM. Every reasoning step is a Claude API call; the device handles only deterministic control flow, voice I/O, and secure storage.

| Runs on device (no LLM) | Runs via Claude API |
|---|---|
| Wake / push-to-talk, STT (Android `SpeechRecognizer`; cloud STT fallback for vernacular) | Intent + slot extraction (request → structured SKU list) — same single model |
| TTS playback (Android TTS / Bhashini) | Procurement **planning** (decompose request, choose platforms) |
| Rule-based secret scrubbing before any API call | **DOM grounding** (pick which element to click from the serialized page) |
| The deterministic perceive→act loop control | Ambiguity resolution ("paneer" → which pack size?) |
| Secure session/cookie storage | Comparison narration in rupees; pre-checkout verification |

Design implication: in MVP a single strong Claude model serves planner, grounder, intent and verifier (tiering is a later cost optimization). Minimise round-trips and tokens. Prefer **deterministic playbooks** for known steps (no LLM call); fall back to a Claude call only when a selector breaks or a layout is novel. Send compact serialized DOM, not raw HTML. Cache normalized SKU mappings so repeat orders need few/no LLM calls. All Claude calls go through the **Spring Boot backend** (key never ships in the app); the backend also enforces secret-scrubbing and rate limits, and is where the agent reasoning endpoints live (§3.5).

### 3.3 Agent core — Planner / Executor / Verifier

Reuses the Planner–Executor–Ranker shape proven in the Swiggy/Zomato accessibility work.

- **Planner (Claude):** turns the parsed request into a structured plan — `{normalizedItem, qty, unit, constraints}` and the platforms to query (Amazon, Hyperpure).
- **Site Executor (per adapter):** drives one platform through `search → read → addToCart`. Two-tier:
  - **Deterministic playbook first** — recorded selectors/steps per site (fast, cheap, no LLM).
  - **Claude-grounded fallback** — when a selector breaks or layout is novel, serialize the interactable DOM and ask Claude for the next action; self-heals and can promote a new playbook.
- **Comparator/Optimizer:** see §4.
- **Verifier/Critic (Claude, cheap/fast):** before any irreversible step (checkout), re-reads each cart and asserts it matches the approved plan (right SKU, qty, price within tolerance). Blocks on mismatch.
- **HITL gates:** hard stops for (a) plan approval, (b) OTP, (c) payment. The agent surfaces the live WebView at these moments.

### 3.4 WebView automation engine (the core we build)

For platforms we render ourselves we have full control via JS injection — this is the engine that makes Procure Copilot an automation agent in its own right. In MVP this runs on the Capgo InAppBrowser webviews; the same logic ports to native `WebView` instances if needed.

- One webview per platform (Capgo `id`), persistent cookies per platform so login/session survives; a platform can run in **hidden mode** while being driven and only be surfaced for OTP/payment.
- **Perception:** `executeScript` injects a DOM-serialization script that walks the document, collects interactable nodes (`a, button, input, select, [role], [onclick]`, visible text), assigns each a stable integer handle, and posts back compact JSON `{idx, role, text, bbox, attrs}` over the `messageFromWebview` bridge. A `MutationObserver` + the plugin's request-proxy/network-idle signal detects when SPA content has settled.
- **Action:** `executeScript` performs `element.click()`, sets input `.value` + dispatches `input`/`change` events, scroll, select; results return over the message bridge.
- **Anti-fragility:** human-like delays, retry with backoff, screenshot capture on failure (for eval), and a circuit breaker that pauses and asks the human after N failed actions.

> The same perceive→reason→act loop is later reusable over an Accessibility node-tree (native apps) instead of a DOM — but that is future scope, not built here.

### 3.5 JS injection & WebView automation — detailed design

This is the heart of the system. The approach follows the now-standard **DOM-first perceive→reason→act loop** used by production web agents (browser-use scored ~89% on WebVoyager with this exact pattern), adapted to run inside a Capacitor WebView instead of a desktop browser with CDP. The principle: don't make the model read raw HTML or pixels; extract a compact list of *interactable* elements, give each a stable handle, let the model pick an action by handle, execute it, then re-observe. Vision (Set-of-Mark) is a fallback, not the default, because DOM-text is cheaper and avoids the box/label hallucinations that pure-screenshot grounding suffers on dense pages.

#### 3.5.1 Where the pieces run

- **On device (inside the webview, injected JS):** page-settle detection, DOM serialization, action execution, screenshot/SoM marking. This *must* be on-device because the live authenticated session and the rendered DOM live there.
- **On device (Capacitor/TypeScript host):** the loop controller, the per-platform `AutomationEngine`, the message-bridge plumbing, playbook cache, HITL gating.
- **On the Spring Boot backend:** the reasoning calls — `plan`, `next-action` (grounding), `verify` — which wrap Claude; the playbook registry; the optimizer; eval + telemetry. The device posts a **PII-scrubbed** serialized observation to `/next-action`; the backend calls Claude and returns one structured action.

#### 3.5.2 The Capgo bridge (exact mechanics)

- **App → page:** `InAppBrowser.executeScript({ id, code })` runs JS in the target webview. `InAppBrowser.postMessage({ id, detail })` raises a `messageFromNative` event inside the page.
- **Page → app:** inside the page, `window.mobileApp.postMessage({ detail })` fires the host-side `messageFromWebview` listener with `{ id, detail }`. Payloads must be JSON-serializable, so the injected serializer **posts results back over this channel** rather than relying on `executeScript` return values (which are unreliable/string-only across the bridge). We use a `requestId` in each `detail` to correlate request→response into a Promise.
- **Lifecycle signals:** `browserPageLoaded` (initial load), `urlChangeEvent` (navigation — used to detect login/OTP/payment redirects), `popupWindowOpened` (e.g. a payment-gateway popup → capture its `id`), `screenshotTaken`. A native request **proxy** (`addProxyHandler`/`proxyRequest`) gives request-level visibility for network-idle and host blocking.
- **Sessions:** one webview per platform (`id: "amazon" | "hyperpure"`), opened in **hidden mode** so it loads and runs JS without being shown; cookies persist per webview so a single OTP login carries across orders; `show({ id })` reveals it only at HITL moments.

#### 3.5.3 The loop (per platform, per subtask)

```
open(id, url, hidden:true)
  → await browserPageLoaded(id)
  → injectSettleWaiter(id)        // resolves on network+DOM idle
  → await ready
loop:
  obs = serializeDOM(id)          // injected JS posts {elements,url,title,scroll}
  obs = scrub(obs)                // strip emails/phones/OTP-like/token-like strings
  action = playbook.next(state) ?? backend.nextAction(task, obs, history)
  switch action.type:
    click | type | select | scroll | navigate  → executeAction(id, action)
    extract            → return action.data
    needs_human(OTP|payment)     → show(id); await humanDone; continue
    done | fail        → break
  await settle(id)
  verifyStepEffect(obs_before, serializeDOM(id), action)   // did it do what we expected?
```

Each step **re-serializes** — the page may have mutated, navigated, or re-rendered (SPA). Handles are regenerated every step, so the model always references the current DOM.

#### 3.5.4 DOM serialization (the injected perceiver)

Injected once per step. It walks the document (including **open shadow roots** and **same-origin iframes**; cross-origin iframes are unreadable by design — that's exactly where payment gateways live, and where we hand off to the human), selects interactable + meaningful nodes, tags each with a stable `data-pc-idx`, and posts a compact list back. Token discipline matters: a raw DOM snapshot can run into hundreds of thousands of tokens, so we serialize only what's interactable/visible and truncate text.

```js
// injected; simplified
(function (requestId) {
  const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','OPTION','LABEL']);
  const ROLES = new Set(['button','link','menuitem','tab','checkbox','radio','option','combobox','searchbox','textbox']);
  const out = []; let idx = 0;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
        && s.display !== 'none' && +s.opacity > 0;
  };
  const interactive = (el) => INTERACTIVE.has(el.tagName)
    || ROLES.has(el.getAttribute('role'))
    || el.hasAttribute('onclick')
    || el.tabIndex >= 0
    || getComputedStyle(el).cursor === 'pointer';

  function walk(root) {
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) walk(el.shadowRoot);            // pierce shadow DOM
      if (!interactive(el) || !visible(el)) return;
      el.setAttribute('data-pc-idx', idx);               // stable handle for the act phase
      const r = el.getBoundingClientRect();
      out.push({
        idx,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        name: (el.getAttribute('aria-label') || el.innerText || el.value ||
               el.placeholder || el.alt || '').trim().slice(0, 120),
        value: el.value ?? null,
        bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        attrs: { type: el.type || null, name: el.name || null, href: el.href || null }
      });
      idx++;
    });
  }
  walk(document);
  document.querySelectorAll('iframe').forEach((f) => {       // same-origin iframes only
    try { walk(f.contentDocument); } catch (_) { /* cross-origin: skip */ }
  });

  window.mobileApp.postMessage({ detail: {
    requestId, type: 'dom',
    url: location.href, title: document.title,
    scroll: { y: scrollY, h: document.body.scrollHeight, vh: innerHeight },
    elements: out
  }});
})('REQUEST_ID');
```

The host turns `elements` into a numbered list for the model, e.g. `[12] button "Add to cart"` / `[3] searchbox "Search for products"`. The model replies with one action referencing an `idx`. AdaptiveD2Snap-style pruning (cap element count, drop far-offscreen nodes unless we intend to scroll) keeps the payload within a token budget.

#### 3.5.5 Page-settle / network-idle detection

`browserPageLoaded` only signals the initial document; SPA content (Amazon/Hyperpure search results) arrives later. The injected settle-waiter resolves when the DOM has been quiet **and** no fetch/XHR has been in flight for a debounce window, with a hard timeout:

```js
(function (requestId) {
  let inflight = 0, timer;
  const done = () => window.mobileApp.postMessage({ detail: { requestId, type: 'ready' } });
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => inflight === 0 && done(), 600); };
  const _f = window.fetch; window.fetch = function (...a) { inflight++; bump();
    return _f.apply(this, a).finally(() => { inflight--; bump(); }); };
  new MutationObserver(bump).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(done, 8000);   // safety cap
  bump();
})('REQUEST_ID');
```

The native request proxy is a second, more reliable idle signal where the injected patch is insufficient.

#### 3.5.6 Action execution

Actions are resolved against the `data-pc-idx` tagged in serialization, so the act phase hits the exact node the model chose. Text entry handles React/Vue-controlled inputs by using the native value setter then dispatching `input`/`change`, otherwise the framework overwrites the value.

```js
function act(a) {                                  // a = {type, idx, value}
  const el = document.querySelector(`[data-pc-idx="${a.idx}"]`);
  if (!el) return post({ ok:false, reason:'stale-handle' });
  el.scrollIntoView({ block:'center' });
  if (a.type === 'click') { el.click(); }
  if (a.type === 'type') {
    const proto = el.tagName==='TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el, a.value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  if (a.type === 'select') { el.value = a.value; el.dispatchEvent(new Event('change',{bubbles:true})); }
  post({ ok:true });
}
```

After each act, `verifyStepEffect` re-serializes and checks the expected change (cart badge incremented, results list non-empty, URL advanced). On mismatch it retries, then falls back to LLM grounding, then trips the circuit breaker.

#### 3.5.7 Playbook-first, LLM-grounded fallback, self-heal

For each platform we record a deterministic **playbook** — ordered steps with selectors for the known flow (focus searchbox → type → submit → first matching result → read price/stock → add-to-cart → open cart). Playbooks run with **zero LLM calls** and are fast and cheap. When a selector misses or `verifyStepEffect` fails (the site changed its layout), the engine falls back to the LLM-grounded loop: serialize → `/next-action` → act. A successful recovery is logged as a **candidate new playbook** and rolled out in **shadow mode** (run alongside, compare, promote when it beats the old one). This keeps steady-state cost low while staying resilient to redesigns. Playbooks live in the backend registry so a selector fix ships without an app release.

#### 3.5.8 Visual (Set-of-Mark) fallback

When DOM-text is ambiguous — an element whose meaning is only visual (icon-only button, canvas-rendered control, price baked into an image) — the engine captures a screenshot, draws numbered boxes over the interactable elements (the `bbox`es we already collected; WebMarker-style), and sends the marked image **plus** the text list to Claude. SoM markedly improves visual grounding, but on dense pages pure-vision mislabels boxes, so we always pair it with the text list and prefer DOM-text first. This path is rare and metered for cost.

#### 3.5.9 OTP & payment hand-off

These are never automated. Detection is twofold: `urlChangeEvent` matching known login/OTP/payment routes, and DOM signals (`input[autocomplete="one-time-code"]`, OTP-styled fields, a cross-origin payment iframe / `popupWindowOpened`). On detection the engine calls `show({ id })` to reveal the live webview, posts a clear prompt ("Enter the OTP Hyperpure just sent you" / "Complete payment to place this order"), and **pauses**. It resumes when it observes the success route or the human taps "done." Because it's the user's own session in a real webview, OTP and payment behave exactly as in the native site.

#### 3.5.10 Reliability & anti-bot posture

- **Human-like pacing:** randomized inter-action delays, scroll-into-view before click, no superhuman speed; throttle to a real shopper's cadence.
- **Real session, real device:** the platform's own cookies and the device WebView's real user-agent — no headless fingerprint, no datacenter IP.
- **Retry/backoff + circuit breaker:** N failed actions on a step → stop and ask the human; never thrash.
- **Screenshots on failure** feed the eval harness (§Epic 7) and reproduce flakes.
- **Idempotency:** order placement carries an idempotency key so a mid-checkout network drop can't double-order.

#### 3.5.11 Worked example — "add 10kg onions on Hyperpure"

1. `open("hyperpure", hyperpure.com, hidden)` → `browserPageLoaded` → settle.
2. Playbook: focus `searchbox` (idx from serialization), `type "onions"`, submit → settle.
3. Serialize results; playbook picks the first card matching onions + 10kg; reads `name`, price, in-stock, delivery date; posts a `Quote`.
4. `click` the card's "Add to cart" (idx) → settle → `verifyStepEffect` confirms cart badge = 1.
5. Repeat for other items / other platform → optimizer → HITL approval → checkout → OTP hand-off if Hyperpure asks → credit available, so place order; else reveal payment.

This entire path is selector-driven (no LLM) once the playbook is recorded; Claude is invoked only if a step fails to verify.

### 3.6 Invocation & data flow (app ↔ webview ↔ backend ↔ UX)

This section answers two things: **how the app kicks off automation**, and **how results flow back and become UX**. Your framing was "pass data to the app, app saves to backend and handles the UX" vs "save to backend and the app polls backend for the UX." The recommended answer is a blend that avoids polling: **the device is local-first and event-sourced** — it owns live run state and renders the UX directly from it, while every state change is also appended to the backend as the durable system of record. You poll the backend only on cold-start/resume, never during a live run.

#### 3.6.1 Why not a backend-driven loop or polling

The webview and the perceive→act execution **must** run on the device (that's where the authenticated session and the rendered DOM are). So the device is already the active driver and knows the truth first. Two consequences:

- **Don't poll your own backend for state you just produced locally** — it adds latency and battery cost for data the app already has. The UX binds to the device's in-memory session state and updates instantly.
- **Don't put the tight loop's source of truth on the backend.** A backend-orchestrated loop would make every perceive→act step a round-trip to a *stateful* server and require remote-controlling the device — double the latency on the hot path. The backend stays a **stateless reasoning provider** (`/plan`, `/next-action`, `/verify`) plus a **durable event store**. (The `AutomationEngine` is a thin executor, so if you ever want server-side orchestration later, you can move the controller up without touching the engine.)

#### 3.6.2 Invocation path (app → engine → webview)

1. Conversation layer parses the request into a `ProcurementRequest` and the app's on-device `OrchestratorService` opens a `ProcurementSession` (a state machine).
2. Orchestrator calls backend `POST /plan` → structured plan (`{normalizedItems, platforms}`).
3. For each platform the orchestrator gets an `AutomationEngine` bound to a webview `id` (opened hidden) and calls a typed async API — `engine.search(item)`, `engine.readProduct()`, `engine.addToCart(items)`, `engine.checkout()`. Internally each of these runs the §3.5 perceive→act loop via `InAppBrowser.executeScript / openWebView / postMessage`.
4. The engine emits **typed domain events** upward (see 3.6.3) rather than returning raw DOM.

The app never speaks the bridge directly; it speaks the `AutomationEngine` interface. The bridge is an implementation detail behind it.

#### 3.6.3 Data-return path (webview → app)

Two channels over the one Capgo bridge:

- **Request/response (correlated):** when the host needs a specific result (a DOM snapshot, an action's outcome), it injects code carrying a `requestId`; the injected JS posts `window.mobileApp.postMessage({ detail: { requestId, ... } })`; the host's single `messageFromWebview` listener matches `requestId` to a pending Promise and resolves it. This turns the fire-and-forget bridge into clean `await`able calls.

```ts
// host side — one listener, promise correlation
const pending = new Map<string, (v:any)=>void>();
InAppBrowser.addListener('messageFromWebview', (e) => {
  const { requestId, ...data } = e.detail ?? {};
  if (requestId && pending.has(requestId)) { pending.get(requestId)!(data); pending.delete(requestId); }
  else dispatchEvent(data);            // unsolicited → event channel (3.6.3b)
});
function call(id:string, codeFactory:(rid:string)=>string){
  const rid = crypto.randomUUID();
  return new Promise(res => { pending.set(rid, res);
    InAppBrowser.executeScript({ id, code: codeFactory(rid) }); });
}
// usage:  const dom = await call('hyperpure', rid => serializerSrc(rid));
```

- **Unsolicited events:** lifecycle/HITL signals the page raises on its own — `urlChangeEvent` (login/OTP/payment redirect), `popupWindowOpened` (payment gateway), or a settle/`ready` ping — are routed to the engine's event stream, which translates them into domain events: `QuoteRead`, `ItemAddedToCart`, `NeedsOtp`, `NeedsPayment`, `OrderPlaced`, `StepFailed`.

#### 3.6.4 State ownership, persistence & UX

The orchestrator is the single writer of `ProcurementSession` state. On every domain event it does two things, in this order:

1. **Update local state → UX re-renders reactively.** The session lives in an observable store (Ionic/Angular signals or a Redux-style store); the screens subscribe. This is the live UX path — zero network, instant.
2. **Append the event to the backend** as an immutable record: `POST /sessions/{id}/events` (fire-and-forget with a local outbox + retry so a connectivity blip never blocks the UX). The backend persists it (system of record), updates its projection, and feeds telemetry/eval.

So: **the app handles the live UX from local state, and also saves to the backend** — your first option, done right. Polling is *not* used for the live run. The backend copy earns its keep for durability, audit, analytics, resume, and any second screen.

#### 3.6.5 When the backend *does* drive the UX (resume / second screen)

- **Cold start / app killed mid-run:** on launch the app calls `GET /sessions/{id}` (or `/sessions?status=active`) once and **hydrates** the state machine from the persisted event log, then continues live. This is the only "read from backend" on the normal path — a one-shot hydrate, not a poll.
- **Live remote viewing (e.g., owner watches on another device, or an ops dashboard):** use **server push (SSE or WebSocket)** from the backend event stream — `GET /sessions/{id}/stream` — not polling. Polling is acceptable only as a crude fallback or for non-realtime history lists.

#### 3.6.6 End-to-end sequence

```
User ── "order onions + paneer" ──▶ Conversation Layer
                                       │ ProcurementRequest
                                       ▼
                              OrchestratorService (device)
            POST /plan ───────────────┤────────────────▶ Backend (Claude) ──▶ plan
                                       │◀───────────────── plan
        for each platform:            │
   engine.search()/addToCart() ──────▶ AutomationEngine ──executeScript──▶ WebView(JS)
                                       │◀── messageFromWebview {requestId} ── DOM/result
        (on selector miss)            │
   POST /next-action {obs} ──────────▶│────────────────▶ Backend (Claude) ──▶ action
                                       │◀───────────────── action
   domain event (e.g. QuoteRead) ─────┤
        1) update local store ────────┼────────────────▶ UX renders (instant, no poll)
        2) POST /sessions/{id}/events ┼────────────────▶ Backend persists + telemetry
   NeedsOtp / NeedsPayment ───────────┤── show(webview) ─▶ User completes ──▶ resume
   OrderPlaced ───────────────────────┘────────────────▶ Backend (audit, receipts)
```

#### 3.6.7 Contract summary

- **Device → AutomationEngine (in-process API):** `open/close`, `search`, `readProduct`, `addToCart`, `getCart`, `checkout`, `placeOrder`, `+ on(event)`.
- **Device → Backend (HTTP):** `POST /plan`, `POST /next-action`, `POST /verify`, `GET /playbooks/{platform}`, `POST /sessions`, `POST /sessions/{id}/events`, `GET /sessions/{id}`, `GET /sessions/{id}/stream` (SSE).
- **Source of truth:** backend event log (durable); device in-memory session (live working copy, continuously checkpointed). UX binds to device state during a run; hydrates from backend on resume.

---

## 4. The cart-split optimizer (algorithmic core)

This is the part that creates real value.

**Problem.** Given required items (SKU, qty), each available on a subset of platforms at a price with a stock cap, and each platform having a delivery fee `f_p`, minimum order value `MOV_p`, available credit `cred_p`, and delivery date `d_p`, choose how much of each item to buy on each platform to minimise total landed cost while meeting demand.

**MILP formulation (v1, OR-Tools CP-SAT):**
- `x[i,p]` ≥ 0 integer = qty of item *i* on platform *p*
- `y[p]` ∈ {0,1} = platform *p* used
- Demand: `Σ_p x[i,p] = req[i]` (or allow shortfall with a penalty term)
- Stock: `x[i,p] ≤ stock[i,p]`
- Linking: `x[i,p] ≤ M·y[p]`
- MOV: `Σ_i price[i,p]·x[i,p] ≥ MOV_p · y[p]`
- Credit (optional hard cap): `Σ_i price[i,p]·x[i,p] ≤ cred_p` when paying on credit
- **Objective:** `min Σ price[i,p]·x[i,p] + Σ f_p·y[p] (+ delivery-date penalty + shortfall penalty)`

**Greedy heuristic (MVP, ships first):**
1. Assign each item to its cheapest available platform.
2. For any platform below its MOV, either top up the cheapest filler item or move its items to the other platform to avoid an extra delivery fee — pick whichever is cheaper.
3. Respect credit caps; overflow to pay-now.
4. Emit a per-order P&L in rupees vs the naive "everything on one platform" baseline.

Ship greedy in MVP; swap in CP-SAT behind the same `optimize(plan, quotes) → allocation` function once correctness matters. With only two platforms the greedy result is near-optimal in most baskets. Output is always an **explainable** allocation (per-item reason + total saving) because the retailer must approve it.

---

## 5. Tech stack

| Concern | Choice | Note |
|---|---|---|
| App shell | **Capacitor + Ionic (Angular/React/Vue)**, single web codebase | Android-first; see §5.1 |
| Automation engine | **Capgo `@capgo/capacitor-inappbrowser`** — multi-webview, hidden mode, `executeScript`, postMessage bridge, cookies, screenshots, request proxy | behind a clean `AutomationEngine` interface so a native plugin can replace it |
| LLM (all reasoning) | **One strong Anthropic Claude model via API**, called through the Spring Boot backend | no tiering in MVP; key never on-device |
| Prompt-opt | DSPy (MIPROv2) for planner/grounder modules | later optimization |
| STT / TTS | Android `SpeechRecognizer` + cloud STT fallback; Android TTS / Bhashini | Hindi/Bengali; not an LLM |
| Optimizer | greedy in MVP; OR-Tools CP-SAT (Java/Python) on the backend | runs server-side |
| Playbook delivery | registry on backend + cached in-app | fix selectors without app release |
| Secure store | Capacitor Secure Storage / Android Keystore-backed; encrypted SQLite | sessions, audit |
| Backend | **Spring Boot (MVP)** — Anthropic proxy, agent brain endpoints, playbook registry, optimizer, eval, telemetry | see §3.5 |
| Observability | OpenTelemetry + Langfuse traces of each agent step | reuse existing setup |

### 5.1 App-shell decision: Capacitor vs native Kotlin

The one hard requirement is injecting JS into and reading the DOM of *third-party* sites (Amazon, Hyperpure) while holding a separate authenticated session per platform. A pure PWA/browser tab **cannot** do this (Same-Origin Policy; Amazon sends `X-Frame-Options: DENY`), so a WebView-hosting app shell is mandatory either way.

The Capgo InAppBrowser plugin now covers what this product needs: cross-origin `executeScript`, two-way `postMessage`, multiple concurrent webviews (addressed by `id`), a **hidden mode** that runs JS without showing the webview (lets the agent drive a platform in the background and surface it only for OTP/payment), per-URL cookie control, PNG screenshots, and a request proxy for network-idle detection. That makes **Capacitor a viable choice for the MVP**, which suits a web-strong team while keeping the heavy reasoning on a Spring Boot backend.

Tradeoff vs native Kotlin (multi-`WebView` + `evaluateJavascript`): native gives maximum control over OEM WebView quirks, lifecycle and network-idle, and removes a community-plugin dependency on the riskiest subsystem — at the cost of build speed and a second codebase. **Mitigation:** keep the automation behind an `AutomationEngine` interface; if a target site defeats the plugin, reimplement just that engine as a native Capacitor plugin without touching the rest of the app.

---

## 6. Core agent loop (pseudocode)

```
parse(input)            → intent, items[]                 // STT on-device, parse via Claude
plan = Planner(items)   → {normalizedItems, platforms}    // Claude
for p in [hyperpure, amazon] (parallel WebViews):
    for item in plan.items:
        adapter[p].search(item)
        quote = adapter[p].readProduct(item)   // playbook → Claude fallback
        quotes[p][item] = quote
allocation = optimize(plan, quotes)            // greedy / MILP
present(allocation)  → HITL: proceed? modify?  // STOP, show rupee P&L
if approved:
    for p, items in allocation:
        adapter[p].addToCart(items)
        Verifier.assertCartMatches(adapter[p].getCart(), allocation[p])  // STOP on mismatch
        result = adapter[p].checkout()
        if result == NEEDS_OTP:     HITL.requestOtp(p)       // human
        if result == NEEDS_PAYMENT: HITL.requestPayment(p)   // human
        if result == CREDIT_OK:     adapter[p].placeOrder()
audit.log(everything)
```

---

## 7. Data model (core entities)

`Retailer`, `PlatformAccount(platform, sessionRef, creditAvailable)`, `CanonicalItem(name, unit, synonyms, category)`, `PlatformSKU(platform, canonicalItemId, packSize, mappingConfidence)`, `Quote(sku, price, mrp, inStock, deliveryDate, mov, fees)`, `ProcurementRequest`, `Allocation(item→platform→qty→reason)`, `OrderAttempt(platform, status, total, paidOnCredit, timestamps)`, `AuditEvent(actor, action, before/after, screenshotRef)`, `Playbook(platform, flow, selectors, version)`.

SKU normalization (mapping "Aashirvaad Atta 10kg" across Amazon and Hyperpure to one `CanonicalItem`) is its own hard sub-problem — embeddings + fuzzy match + human-confirmed mapping cache. Budget for it.

---

## 8. Work breakdown — epics, tech tasks, feature tasks

> Rough engineer-weeks for a small team. "Quick implementation" = Epics 0–6 happy path on **Hyperpure + Amazon.in**.

### Epic 0 — Foundations
- **Tech:** project scaffold (Ionic + Capacitor, Capgo InAppBrowser), secure store (Keystore-backed + encrypted SQLite), `PlatformAdapter`/`AutomationEngine` interfaces, telemetry (OTel→Langfuse), feature flags, audit log, serverless Claude API proxy + secret-scrubbing, remote-config playbook loader.
- **Feature:** onboarding; add-platform flow (user logs into each platform once inside an in-app WebView; we persist the session); settings.
- **Implemented:** Ionic + Capacitor + Capgo scaffold; Spring Boot Anthropic proxy with `ANTHROPIC_STUB_MODE` deterministic offline path; hash-chained on-device audit log; `AutomationEngine` interface (plus the `PlatformAgent`/`BrowserSession` agent seam, §0); the guided-knowledge endpoint (`/knowledge`); a **first-run login gate** (`auth/loginStore.ts` + `ui/pages/LoginGate.tsx`, booleans only); opt-in debug tracing (`debug/automationDebug.ts`); and a `VITE_DEMO` demo seam (`MockAutomationEngine`). Secure-store is an in-memory seam in the app today (Keystore/SQLCipher wiring pending).

### Epic 1 — Conversation & intent
- **Tech:** STT integration (+ vernacular), chat UI, voice push-to-talk, Claude-based intent/slot extraction, secret scrubbing before API calls.
- **Feature:** "type or speak your order," confirmation chips, editable parsed item list, multilingual prompts.
- **Acceptance:** "5 kilo aloo aur 2 carton tel" → `[{aloo,5,kg},{refined oil,2,carton}]` with ≥95% slot accuracy on a 200-utterance test set.
- **Implemented:** `/intent` parser extracts **brand / variant / pack size + count** alongside qty/unit; an offline rule parser (stub mode) with a Claude path for branded/complex orders; device-side secret scrubbing (`intent/scrubForApi.ts`); editable item-list model (`intent/itemListModel.ts`) surfaced on item cards; i18n strings (en/hi/bn). Chat UI is implemented; a `SpeechInput` seam (`intent/speech.ts`) exists but the native Android STT implementation is not yet wired (a `NoopSpeechInput` stub is used, so text entry is the live path today).

### Epic 2 — WebView automation engine ← core
- **Tech:** per-platform webview management (Capgo `id` + hidden mode), session/cookie persistence, DOM-serialization injection, action executor (`click/type/scroll/select`), MutationObserver + network-idle wait, message-bridge data return, screenshot capture, retry/backoff, circuit breaker.
- **Feature:** "show me what the agent is doing" live WebView surface.
- **Acceptance:** deterministically search, read price, and add a known SKU on a fixed test page with <2% flake over 100 runs.
- **Implemented:** the Capgo bridge (`automation/bridge.ts`, + jsdom `MockBridge`), injected DOM serializer / settle-waiter / action executor (`automation/injected/`), per-platform hidden webviews, screenshot capture, retry/backoff + circuit breaker, `verifyStepEffect`, and OTP/payment detection. The agent layer adds raw `observe`/`act`/`captureScreenshot` primitives via `BrowserSession`. The "what the agent is doing" surface is the opt-in debug overlay (§3.5 / Epic 0); the bridge also traces injected `[hpinj]` diagnostics and filters benign console noise.

### Epic 3 — Site adapters: Hyperpure + Amazon.in
- **Tech:** record deterministic playbooks per site (search box, result card, price node, add-to-cart, cart page, checkout entry, OTP detector, payment-vs-credit detector); Claude-grounded fallback wired in.
- **Feature:** per-platform health indicator; "playbook stale" self-heal banner.
- **Acceptance:** end-to-end add-to-cart for 20 common SKUs on each platform, ≥90% success unattended, 100% safe-stop before checkout.
- **Implemented:** the divergent per-platform logic now lives in dedicated **agents** (§0), not a shared playbook. `HyperpureAgent` searches by navigating **straight to the deterministic results URL** (`/in/search/<slug>?type=SEARCH&query=…`) and adds from the **product detail page** (`/in/<slug>`), clicking ADD and **confirming** via the ADD→stepper swap or a cart-count rise (honest `failed` + product link otherwise). `AmazonAgent` reads the **true detail-page buybox price** (fixing the listing ₹99-vs-real-₹237 bug), extracts the ASIN, and does a native add-to-cart with added/failed confirmation. Curated per-platform **knowledge hints** (`knowledge/`) steer extraction. **Amazon is currently disabled** (AWS-WAF bot-wall — see §0); Hyperpure is the live platform. The Claude-grounded `/next-action` fallback and recorded fixtures exist; a UI health indicator / "playbook stale" banner is pending.

### Epic 4 — Comparison & optimizer
- **Tech:** SKU normalizer (embedding + fuzzy + confirmed cache), `optimize()` greedy, per-order P&L generator, then CP-SAT behind same interface.
- **Feature:** comparison card in rupees with per-item reason and total saving vs single-platform baseline.
- **Acceptance:** optimizer never proposes an out-of-stock item; greedy within 5% of MILP optimum on a 50-case benchmark.
- **Implemented:** greedy `optimize()` on the backend (`POST /optimize`) + the rupee comparison card. Three pricing refinements landed on the device: **pack-price normalisation** (`pricing/packPricing.ts`, ₹/kg·L·piece), **best-value default pins** (`optimizer/defaultSelection.ts`, lowest per-unit price so a 1 kg pack isn't beaten by a cheaper-looking 500 g pack), and **quantity reconciliation** (`pricing/quantityReconcile.ts`, `ceil(totalRequested / soldPackSize)`), all wired through `Orchestrator.optimize` so the comparison UI and staged cart use the correct counts. A **candidate / nearby-SKU picker** also landed: `/vision/extract` returns a ranked top-N, the device classifies each match as `exact`/`nearby` (`pricing/matchKind.ts` `chooseQuote`) and auto-picks the cheapest exact ₹/unit, and `ComparisonPage` surfaces an inline picker (`select-sku` → re-optimize) only when the default is a `nearby` match. **Pending:** the embedding/fuzzy SKU normalizer and the CP-SAT optimizer (greedy ships).

### Epic 5 — HITL confirmation UX
- **Tech:** approval state machine; modify flow (swap platform / qty / drop item → re-optimize); idempotent resumable session.
- **Feature:** "Proceed / Modify / Cancel," inline edits, plain-language explanation, voice read-back.
- **Acceptance:** modifying any line re-runs optimization and re-renders within 2s; nothing irreversible without explicit approval.
- **Implemented:** the event-sourced `ProcurementSession` + single-writer `Orchestrator` (durable outbox, approval state machine); the comparison page supports per-item platform switching and re-optimize; plain-language rupee explanation. Voice read-back is pending (tied to the STT/TTS seam in Epic 1).

### Epic 6 — Checkout, OTP, payment, ordering
- **Tech:** Verifier (cart-vs-plan assertion); checkout driver per platform; OTP hand-off (surface native field, never auto-fill); payment-required detection; credit-available → place order; order-confirmation parser; full audit trail.
- **Feature:** OTP prompt, "complete payment" hand-off screen, order summary + reference numbers, receipts.
- **Acceptance:** Verifier blocks 100% of injected cart-mismatch cases; agent pauses for human at every OTP/payment; order reference captured and stored.
- **Implemented:** the `VerifierClient` cart-vs-plan gate, an **idempotent** `CheckoutDriver`, the OTP/payment HITL hand-off (`show()` + `awaitHuman()`, never auto-filling), the order-confirmation parser, and the hash-chained audit trail. **The live flow runs `CheckoutDriver.stageCart`** — a cart hand-off that best-effort adds each approved line (consuming each agent's `AddToCartResult`) and then stops, surfacing per-line "Added"/"Couldn't add — open product" links and a "Review & checkout on {platform}" cart link in `OrderSummaryPage`; `ProcureFlow.openProductForAdd`/`openCartForReview` foreground the WebView. The fully-automated `run()` path (verify → checkout → OTP/payment → place under idempotency) exists and is tested, but is not the default journey.

### Epic 7 — Observability, eval & self-healing (continuous)
- **Tech:** golden-path eval harness (replayable site fixtures), step-level traces, playbook drift detection, shadow-mode for new playbooks, grounder confidence calibration, counterfactual logging. (Mirrors the QA framework already designed for the shopping agent.)
- **Implemented (partial):** opt-in step-level tracing on-device (`debug/automationDebug.ts` overlay + `adb logcat`, including every backend/LLM call), backend telemetry step traces, recorded site fixtures, a guided-knowledge layer that can `recordObservation` against a per-platform corpus, and a durable on-device `SiteMemory` that learns product URLs + element signatures from successful runs. **Reliability guardrails** also shipped here: self-explanatory Claude HTTP-error messages + a boot `AnthropicStartupProbe` (loudly flags a retired/unreachable model id so it surfaces as config, not as in-app "nothing found"); the outbox drops permanent `4xx` (`BackendHttpError.isClientError`) instead of retry storms; and the `bridge.open()` close-then-reopen fix for the webview lifecycle. **Pending:** the replayable golden-path eval harness, playbook drift detection / shadow-mode promotion, grounder confidence calibration, and the continuous RAG learning loop (observations are advisory today, not yet folded back into extraction automatically).

---

## 9. Test strategy & cases

### 9.1 Unit
- Slot parser: quantities, units, synonyms, vernacular numerals, "dozen/carton/packet."
- Optimizer: demand met; stock caps; MOV satisfied; credit cap honoured; greedy-vs-MILP gap; tie-breaking; empty-availability → graceful "not found."
- SKU normalizer: correct mapping; low-confidence → flagged for human.
- Detectors: `needsOtp`, `needsPayment`, `creditOk`, order-confirmation parse.

### 9.2 Integration (per adapter, against recorded site fixtures)
- search returns parsed price/stock/delivery-date for known SKUs.
- add-to-cart reflects in cart read-back.
- layout-change fixture → Claude fallback recovers; new playbook proposed in shadow mode.
- session-expired fixture → adapter requests re-login, doesn't crash.

### 9.3 End-to-end (happy + unhappy)
- Single-platform order; multi-platform split order.
- Item out of stock on cheaper platform → optimizer reroutes.
- Below-MOV platform → top-up vs reroute decision is the cheaper one.
- Credit available → order placed; credit exhausted → pauses for payment.
- OTP required mid-flow → human hand-off, resume after entry.
- User taps **Modify** at approval → re-optimize → re-approve.
- Network drop mid-checkout → resumable, no duplicate orders (idempotency keys).

### 9.4 Agent-eval golden set
- 100+ realistic baskets with known optimal allocation; assert allocation quality, action success rate, and **zero unsafe auto-checkout.**
- Adversarial pages: moved buttons, fake "Buy now" lookalikes, modal interstitials, infinite scroll, price in image not text.

### 9.5 Security & safety
- Credentials/sessions never in plaintext; never sent to API; secret-scrubbing verified on every API call.
- OTP/payment **cannot** be auto-completed (assert no code path fills them).
- Verifier blocks tampered carts; circuit breaker trips after N failures.
- Audit log complete and tamper-evident for every order.

### 9.6 Non-functional
- WebView memory with two concurrent platforms; cold-start time; Claude API latency/cost budget per order (cap tokens, prefer playbooks); vernacular STT WER on field recordings.

---

## 10. Extensibility (designed-for, not built)

The `PlatformAdapter` interface (§3.1) is the single seam that keeps all of the below additive — none require changing the orchestrator, optimizer, HITL or audit layers:

- **More web platforms** (e.g. Udaan): add a new WebView-backed adapter + playbooks.
- **Native-app-only platforms** (e.g. Metro Wholesale, Jumbotail): add an Accessibility-Service-backed adapter — same perceive→reason→act loop over an `AccessibilityNodeInfo` tree instead of a DOM, gesture dispatch instead of JS `click()`. This is the path that makes Procure Copilot able to operate *any* app, not just websites.
- **Official partner APIs** (e.g. JioMart B2B): add a REST-backed adapter and retire the WebView playbook for that platform with zero core changes.
- **iOS:** WebView path ports; cross-app control does not (platform limitation) — revisit per-platform.

Build the interface and the optimizer/HITL/audit layers to be platform-count-agnostic from day one so these stay drop-in.

---

## 11. Phased roadmap

| Phase | Scope | Outcome |
|---|---|---|
| **MVP** | Epics 0–6, greedy optimizer, full HITL (**Hyperpure live; Amazon disabled** — see §0) | Retailer types an order, sees a rupee-saving split, approves; agent stages each active platform's cart and hands off to the user to review + check out (OTP/payment always human) |
| **v1** | CP-SAT optimizer, eval harness, self-heal/shadow-mode, hardening | Defensible quality bar on two platforms |
| **Future (out of scope)** | New web adapters, Accessibility-driven native apps, partner-API adapters, iOS | Enabled by the adapter interface; not built in this plan |

---

## 12. Top risks & mitigations

| Risk | Mitigation |
|---|---|
| ToS / account ban from automation | Own-account + per-action consent + human-like pacing; adapter interface lets us swap WebView→partner API later |
| Site layout changes break playbooks | Claude-grounded fallback + shadow-mode promotion + drift alerts |
| Wrong item bought | Verifier gate + mandatory human approval + SKU-mapping confidence threshold |
| Credential/OTP leakage | On-device-only secure store; never auto-fill OTP; secret-scrubbing before any API call |
| Claude API latency/cost per order | Deterministic playbooks first; LLM only on novel/broken steps; compact serialized DOM; cache SKU mappings |
| Anti-bot detection | Real session, real device, throttle, no headless |

---

## 13. Decisions — resolved & remaining

**Resolved for MVP:**
1. **LLM** — one strong Anthropic Claude model for all reasoning; tiering deferred. Routed via a serverless API proxy (and your NAM gateway if preferred).
2. **Form factor** — standalone Android app (not embedded in ShopOS WhatsApp flow yet).
3. **Platform** — Android only.
4. **Backend** — Spring Boot is part of MVP: Anthropic proxy, agent brain endpoints (plan/next-action/verify), playbook registry, optimizer, eval, telemetry. Device runs webviews + perceive→act loop.
5. **App shell** — Capacitor + Capgo InAppBrowser, automation behind a swappable interface.

**Still to decide:**
- ~~Which **Claude model** specifically~~ — **resolved:** `ANTHROPIC_MODEL=claude-sonnet-4-6` (the prior
  `claude-opus-4-20250514` was retired by Anthropic; the startup probe now guards against this class of
  failure). Revisit per cost/latency-per-order budget.
- **STT provider** for reliable Hindi/Bengali field audio (Android `SpeechRecognizer` vs Bhashini vs cloud).
- Whether to stand up the **remote-config playbook endpoint** day one (recommended) or bundle-only until first selector breakage.
- Pilot cohort: how many retailers, which city, and whose Amazon/Hyperpure accounts (consent + ToS posture).

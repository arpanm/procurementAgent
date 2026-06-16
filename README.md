# Procure Copilot — MVP

Mobile (Android-first) agentic procurement assistant. A retailer says/types an order; the app reads
prices in controlled WebViews using **per-platform agents**, runs a cart-split optimizer, shows a
rupee-saving split for approval, then best-effort **stages each platform's cart** and hands off to the
user to review and check out (OTP/payment is **always** the human — no code path auto-fills either).

> **Active platforms:** **Hyperpure is live; Amazon is currently disabled.** Amazon's mobile site
> serves an AWS-WAF bot-challenge that won't execute in the WebView (blank screen,
> `AwsWafIntegration is not defined`, 0 elements), so it can't be sourced reliably. The `AmazonAgent`
> code is retained for re-enablement — the active set is the one-line `ACTIVE_PLATFORMS` in
> `app/src/core/config.ts` (override with `VITE_ACTIVE_PLATFORMS`).

This repo implements **Epics 0–6** of [`PROCURE_COPILOT_PLAN.md`](./PROCURE_COPILOT_PLAN.md) (the MVP),
plus a per-platform agent split, true-price reads, quantity reconciliation, a guided-knowledge layer +
durable on-device site memory, a candidate / nearby-SKU picker, a first-run login gate, and a cart hand-off.

> 📐 **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** is the detailed architecture reference — diagrams,
> flowcharts and code links for the UI/WebView layer, per-platform login, intent classification, the RAG /
> site-memory pipeline, agent execution, comparison, add-to-cart, the cart hand-off, and
> deployment/observability/eval. Start there for "how does X work?".

## Layout

```
app/        Ionic 8 + Capacitor 8 + React 18 + TypeScript — the on-device app & automation engine
backend/    Spring Boot 3.4 (Java 21, Maven) — Anthropic proxy, agent brain, optimizer, registries, event store
```

### App (`app/src/core`)
- `domain/` — shared entities (money in **paise**), `PlatformId`, `Allocation`, `OrderAttempt`, `StagedLine`…
- `automation/` — **Epic 2** WebView engine: injected DOM serializer / settle-waiter / action executor,
  the Capgo bridge (+ jsdom `MockBridge`), the perceive→reason→act loop with retry, circuit breaker,
  `verifyStepEffect`, OTP/payment detection, and the deterministic `MockAutomationEngine` (demo seam).
- `agents/` — **per-platform agents** layered over the engine. `PlatformAgent` is the strategy contract
  (`ensureReady`/`search`/`readQuote`/`addToCart` → `AddToCartResult {status:"added"|"failed", productUrl?,
  cartUrl?, reason?}`); `BrowserSession` extends `AutomationEngine` with raw `observe`/`act`/`captureScreenshot`.
  `AgentRegistry` (`agentFor`/`agentForEngine`) picks the implementation: `amazon/AmazonAgent` (detail-page
  true-price + native add-to-cart, ASIN extraction), `hyperpure/HyperpureAgent` (direct results-URL search +
  detail-page add with add/confirm), or the behavior-neutral `LegacyAgent` (used by the demo mock).
- `adapters/` — **Epic 3** shared playbooks, selectors, recorded fixtures, engine factory + health/self-heal
  (the per-platform agents in `agents/` now own the divergent Amazon/Hyperpure strategy).
- `knowledge/` — **guided-RAG knowledge layer + durable site memory**: `PlatformKnowledgeStore`
  (`getKnowledge`/`recordObservation`, backend transport + built-in `defaults`) feeds agents per-platform
  policies/hints (e.g. `policies.priceFromDetailPage`, `hints.atcTokens`); `siteMemory.ts` + `signature.ts`
  learn durable product URLs + element signatures (search box / product card / ADD button) from successful
  runs (localStorage) and are tried before vision/Claude.
- `intent/` — **Epic 1** device-side scrubber, intent client, editable item-list model, i18n (en/hi/bn).
- `optimizer/` + `pricing/` + `orchestrator/` — **Epics 4/5** event-sourced `ProcurementSession`,
  single-writer `Orchestrator` with a durable outbox, optimizer client + rupee explanation;
  `pricing/packPricing` (₹/kg·L·piece normalisation) + `pricing/quantityReconcile` (pack-count
  reconciliation) + `optimizer/defaultSelection` (best-value default pins).
- `auth/` — `loginStore` (localStorage-persisted per-platform sign-in confirmation; booleans only, never
  credentials/OTPs) behind the first-run login gate.
- `checkout/` + `audit/` — **Epic 6** Verifier gate, idempotent checkout driver (`run` = full place;
  `stageCart` = best-effort add + hand-off), order-confirmation parser, tamper-evident on-device audit log.
- `debug/` — opt-in `automationDebug` tracer + on-screen overlay (`VITE_DEBUG_AUTOMATION=1` / `?debugAuto=1`).
- `backend/`, `secure/`, `config.ts` — backend HTTP client, secure-store seam, app config (`ACTIVE_PLATFORMS`).
- `ui/pages/ProcureFlow.tsx` — the end-to-end flow controller wiring all epics, agents, the login gate and
  the cart hand-off behind the orchestrator.

### Backend (`backend/src/main/java/ai/procurecopilot/backend`)
- `llm/` — **Epic 0** `ClaudeService` (single entry point; stub mode for offline/CI; granular HTTP-error
  hints), `SecretScrubber`, `AnthropicStartupProbe` (boot-time model reachability check).
- `optimizer/` — **Epic 4** greedy cart-split optimizer (`POST /optimize`).
- `agent/` — **Epic 1/2/6** `/intent`, `/plan`, `/next-action` (grounding), `/verify` (cart-vs-plan
  Verifier), `/vision/extract` (screenshot price read).
- `knowledge/` — **guided-RAG** `/knowledge/{platform}` (curated policies + hints) and
  `/knowledge/{platform}/observations` (append a runtime note); the device falls back to built-in defaults.
- `playbook/` — **Epic 0/3** playbook registry (`/playbooks/...`).
- `session/` — **Epic 0/5/6** durable event store + SSE (`/sessions...`).
- `telemetry/` — **Epic 0/7** step traces + audit.

### Key capabilities (current implementation)

- **Per-platform agents.** Amazon and Hyperpure no longer share one playbook. Each platform's strategy
  lives in `app/src/core/agents/`, resolved by `AgentRegistry` and handed a `BrowserSession`.
- **True prices.** `AmazonAgent` opens the product **detail page** and reads the buybox price
  (`amazon/detailExtract.ts`) instead of the noisy search listing (which once read ₹99 for a ₹237 item);
  it extracts the ASIN for a canonical `/dp/<ASIN>` URL.
- **Reliable Hyperpure search & add.** `HyperpureAgent` navigates **straight to the results URL**
  (`/in/search/<slug>?type=SEARCH&query=…`, via `hyperpureSearchUrl`) instead of typing + a synthetic Enter
  that never fired autosuggest; add-to-cart opens the **detail page** (`/in/<slug>`, via
  `hyperpureProductUrl`), clicks ADD and **confirms** via the ADD→stepper swap or a cart-count rise, falling
  back to the listing and returning `failed` + a product link for an honest manual hand-off.
- **Quantity reconciliation** (`pricing/quantityReconcile.ts`): the requested total demand is reconciled to
  each platform's sold pack size — `ceil(totalRequested / soldPackSize)` (10 kg → 50×200 g / 40×250 g /
  20×500 g / 10×1 kg / 5×2 kg / 2×5 kg / 1×10 kg; works for litres/ml too) — wired through
  `Orchestrator.optimize` so the comparison UI and staged cart use the right counts.
- **Best-value defaults** (`optimizer/defaultSelection.ts`): each item is pre-pinned to the lowest
  **₹ per kg/L/piece** (`pricing/packPricing.ts`) so a 1 kg pack isn't beaten by a cheaper-*looking* 500 g pack.
- **Candidate / nearby-SKU picker** (`pricing/matchKind.ts` + `ui/pages/ComparisonPage.tsx`): the vision read
  returns a **ranked top-N** (`/vision/extract` → `candidates[]`); each is classified `exact`/`nearby` and the
  cheapest exact ₹/unit is auto-picked. When the default pick is only a `nearby` match, the comparison page
  shows an inline "choose a nearby SKU" picker (`select-sku` → re-optimize) so you pick without leaving the app.
- **Guided-knowledge layer + site memory** (`knowledge/`): curated per-platform policies/hints steer the
  agents (e.g. Amazon `priceFromDetailPage`, add-to-cart token hints), served by the backend with built-in
  offline defaults. A durable on-device **`SiteMemory`** also learns product URLs + element signatures from
  successful runs and tries them before vision/Claude (`HyperpureAgent.learnFromAdd`/`recallProductUrl`).
  Continuous on-device learning that folds observations back into extraction automatically is **planned/partial**
  (`recordObservation` exists; the persistent learning loop is not yet wired).
- **First-run login gate** (`auth/loginStore.ts` + `ui/pages/LoginGate.tsx`): the user manually signs in to
  each active platform's WebView (OTP + delivery location) once; only a per-platform boolean is persisted —
  never credentials/OTPs. The chat is gated until every `ACTIVE_PLATFORMS` entry is confirmed (demo mode skips it).
- **Cart hand-off** (`checkout/CheckoutDriver.stageCart`): best-effort adds each approved line, then the
  order summary shows items added (with a "Review & checkout on {platform}" cart link) and, for lines it
  couldn't add, an "open it to add manually" product link. OTP/payment is never automated.
- **Debug tracing** (`debug/automationDebug.ts`): with `VITE_DEBUG_AUTOMATION=1` (or `?debugAuto=1`) an
  on-screen overlay + `adb logcat` stream every step, **every backend call including the Claude/vision LLM
  calls** (`backend` channel, with timing + a compact request/response summary), WebView actions, and the
  injected `[hpinj]` settle/emit diagnostics; benign console noise is filtered.
- **Reliability guardrails.** `ClaudeService` returns self-explanatory HTTP errors (404 → "model not found;
  update `ANTHROPIC_MODEL`", 401/403 → key, 429 → quota) and an `AnthropicStartupProbe` loudly flags a
  retired/unreachable model at boot, so a model deprecation surfaces as config — not as in-app "nothing
  found". The orchestrator outbox drops permanent `4xx` (`BackendHttpError`) instead of retry storms, the
  WebView `open()` closes-then-reopens (no stacked webviews / stranded settle), and a failed add hands back an
  honest search URL.

## Configuration (backend env vars)

All backend config is supplied via environment variables (the Anthropic key lives **off-device** and is
never shipped to the app or logged). Defaults are in `backend/src/main/resources/application.yml`.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | _(empty)_ | Your Anthropic key. **Required for live reasoning.** Empty ⇒ stub mode. |
| `ANTHROPIC_STUB_MODE` | `true` | `true` returns deterministic offline completions (no key, good for CI/local). Set `false` for live calls. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Single strong model for all reasoning (no tiering in MVP). |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Override for a proxy/gateway (e.g. your NAM gateway). |
| `ANTHROPIC_VERSION` | `2023-06-01` | Anthropic API version header. |
| `ANTHROPIC_MAX_TOKENS` | `2048` | Max output tokens per call. |
| `SERVER_PORT` | `8080` | HTTP port (Spring `server.port`). |
| `PROCURE_OPTIMIZER_PRICE_TOLERANCE` | `0.05` | Price drift the Verifier tolerates between approved plan and live cart. |

> **Note:** even with `ANTHROPIC_STUB_MODE=false`, the backend automatically falls back to stub mode if
> no key is present, so it never crashes for a missing key.

### Adding your key locally

```bash
cd backend
export ANTHROPIC_API_KEY=sk-ant-...      # your real key
export ANTHROPIC_STUB_MODE=false         # turn on live reasoning
export ANTHROPIC_MODEL=claude-sonnet-4-6
mvn spring-boot:run                      # http://localhost:8080  (health: /actuator/health)
```

A convenient `.env` file (loaded by Docker Compose, see below) — never commit it:

```bash
# .env  (repo root)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_STUB_MODE=false
ANTHROPIC_MODEL=claude-sonnet-4-6
```

## Deploying the backend with Docker

A multi-stage `backend/Dockerfile` builds the fat jar and runs it on a slim JRE as a non-root user.

### Local — Docker Compose (recommended)

```bash
# from the repo root; reads .env automatically
docker compose up --build              # http://localhost:8080
docker compose logs -f backend
docker compose down
```

### Local — plain Docker

```bash
cd backend
docker build -t procure-copilot-backend:latest .
docker run --rm -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e ANTHROPIC_STUB_MODE=false \
  -e ANTHROPIC_MODEL=claude-sonnet-4-6 \
  procure-copilot-backend:latest
```

Verify: `curl http://localhost:8080/actuator/health` → `{"status":"UP"}`.

### Cloud

The same image runs on any container host. Build/push to a registry, then deploy:

```bash
# Build & push (example: GitHub Container Registry / ECR / GCR / ACR)
docker build -t <registry>/procure-copilot-backend:0.1.0 ./backend
docker push <registry>/procure-copilot-backend:0.1.0
```

Then on the platform of your choice, run the image with the env vars set as **secrets** (never bake the
key into the image):

- **AWS** — ECS Fargate / App Runner: container port `8080`, Anthropic key from **Secrets Manager**, health check path `/actuator/health`.
- **GCP** — Cloud Run: `gcloud run deploy procure-copilot --image <registry>/...:0.1.0 --port 8080 --set-secrets ANTHROPIC_API_KEY=anthropic-key:latest --set-env-vars ANTHROPIC_STUB_MODE=false`.
- **Azure** — Container Apps: ingress target port `8080`, key from Key Vault.
- **Kubernetes** — `Deployment` with `containerPort: 8080`, env from a `Secret`, readiness/liveness probe on `/actuator/health`.

Put the service behind **HTTPS** (load balancer / managed TLS) so the mobile app can reach it securely.
Note the public base URL (e.g. `https://api.yourdomain.com`) — the app needs it next.

## Running the app + pointing it at the backend

The app reads the backend base URL from `VITE_BACKEND_URL` at build time (default `http://localhost:8080`,
see `app/src/core/config.ts`).

```bash
cd app
npm install

# Web preview (UI/flow only — live WebView automation needs a device):
VITE_BACKEND_URL=http://localhost:8080 npm run dev
```

Create `app/.env` (or `.env.local`) so you don't repeat it — never commit real URLs/keys:

```bash
# app/.env
VITE_BACKEND_URL=https://api.yourdomain.com
```

#### App build-time env vars (`VITE_*`, read in `app/src/core/config.ts` & friends)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_BACKEND_URL` | _(probes `10.0.2.2:8080`, then `localhost:8080`)_ | Backend base URL(s), comma-separated; the client probes candidates and uses the reachable one. |
| `VITE_ACTIVE_PLATFORMS` | `hyperpure` | Comma-separated platforms the app drives. Amazon is disabled by default (AWS-WAF bot-wall); set `hyperpure,amazon` to re-enable it. |
| `VITE_DEBUG_AUTOMATION` | _(off)_ | `1` opens the WebView **visibly** and streams the live automation + backend/LLM trace to an on-screen overlay and `adb logcat` (`npm run android:debug` sets it). Keep **off** in committed builds. |
| `VITE_DEMO` | _(off)_ | `1` (or `?demo=1` on the URL) swaps the real engine for a deterministic `MockAutomationEngine` so the full journey runs in a plain browser and the first-run login gate is skipped. |

> **First run (real device):** the app shows a one-time **login gate** — open each active platform, sign
> in and set your delivery location, then confirm. Only a boolean per platform is stored (never your
> password/OTP); the WebView cookies persist, so later runs go straight to search. Demo mode skips this.

### Building the Android app

The WebView automation engine (opening the active platforms, searching, staging the cart, OTP/payment
hand-off) **only runs in a real Android WebView** — it cannot run in a desktop browser. So to see the
end-to-end automation you must run on a device or emulator; the app's **first-run login gate** walks you
through signing in to each active platform (Hyperpure today; Amazon is disabled by default — see above)
inside the app's WebViews. To run the journey without real sites/login, use the demo APK
(`npm run android:demo:build`).

#### First-time toolchain setup (once per machine)

Capacitor's Android build needs the **Android SDK** and a **JDK 17 or 21** (the Android Gradle Plugin
does **not** support JDK 22+). If `cap run android` fails with `ERR_SDK_NOT_FOUND`, you're missing the
SDK. Easiest path (macOS):

```bash
# 1) Install Android Studio (bundles the SDK manager, an emulator, and its own JDK 21):
brew install --cask android-studio

# 2) Launch it once and complete the Setup Wizard — it installs the SDK to ~/Library/Android/sdk
#    plus platform-tools and a default system image. Then create an emulator:
#    Android Studio ▸ More Actions ▸ Virtual Device Manager ▸ Create Device (e.g. Pixel 7, API 34).

# 3) Tell the CLI where the SDK lives (add to ~/.zshrc or ~/.bash_profile, then re-open the shell):
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin"
```

> **JDK note:** if your default `java` is 22+ (check `java -version`), CLI Gradle builds will fail.
> Either **run from Android Studio** (it uses its own bundled JDK 21 — simplest), or install a JDK 21
> and point Gradle at it: `brew install --cask temurin@21` then
> `export JAVA_HOME=$(/usr/libexec/java_home -v 21)` before the `android:*` scripts.

The simplest first run is from the IDE: `npx cap open android`, let Gradle sync, start your emulator,
and click **Run** (▶). The CLI scripts below work once `ANDROID_HOME` (and a JDK 21) are set.

#### Building / running

The native project is already scaffolded under `app/android/` (`@capacitor/android`). With the SDK +
emulator in place, the convenience scripts (in `app/package.json`) build the web assets, sync them into
the native project, and launch it:

**Reaching your local backend (most reliable):** use `adb reverse` so the device's own
`localhost:8080` tunnels to your Mac over the adb connection. This works for an emulator **and** a
USB phone, and avoids the emulator NAT (some system images don't route the `10.0.2.2` host alias):

```bash
cd app

# 1) Start your emulator (or plug in a USB phone), then tunnel its localhost to your backend:
adb reverse tcp:8080 tcp:8080      # re-run this after any emulator cold restart

# 2) Build with the device-localhost URL (this is the default in app/.env) and sync:
VITE_BACKEND_URL=http://localhost:8080 npm run build && npx cap sync android

# 3) Install/run the new bundle (either is fine):
npx cap open android        # then click Run ▶ in Android Studio
#   or, if ANDROID_HOME + JDK 21 are on PATH:
npm run android:device
```

Alternatives if you don't want `adb reverse`:

```bash
# Standard emulator host alias (only if your AVD image routes it):
VITE_BACKEND_URL=http://10.0.2.2:8080 npm run build && npx cap sync android   # = npm run android:emulator
# Any cloud / HTTPS backend:
VITE_BACKEND_URL=https://api.yourdomain.com npm run build && npx cap sync android && npx cap open android
```

After any web change, re-run `npm run build && npx cap sync android`, then **redeploy** (Run ▶ in
Studio) — a `cap sync` alone does **not** update the app already installed on the device.

> **Still seeing `Failed to fetch`?** The chat error banner now prints the URL it tried. If it's
> `localhost:8080`, confirm `adb reverse --list` shows the mapping and the backend is up
> (`curl localhost:8080/actuator/health`). If it's a LAN IP, the emulator likely can't reach your
> Mac's private network — switch to the `adb reverse` method above.

#### Automation debug mode (price-scrape diagnostics)

Live scraping of Amazon/Hyperpure is gated behind login + a serviceable delivery area, so a fresh
session returns no quotes. To debug it, set `VITE_DEBUG_AUTOMATION=1` (the `npm run android:debug`
script does this) and redeploy. In debug mode:

- **Sign-in hand-off** — before scraping, each platform opens in a real WebView (nav toolbar). Log in
  and set your delivery location/pincode, then **close the window** to continue. Cookies persist for
  the scrape that follows. (Location permissions are declared in the manifest; sites can also be set
  manually.)
- **Visible scrape** — the search/read runs in a visible WebView so you can watch it.
- **Live trace** — an on-screen overlay (and `adb logcat`) streams `perceive → plan → act → verify →
  fail` plus the per-platform agent's own steps (URLs opened, ADD clicked, confirm/fail). It also traces
  **every backend call — including the Claude/vision LLM calls** — under a `backend` channel
  (`→ POST /next-action …` / `← 200 in 9123ms …`), and the injected in-WebView `[hpinj]` settle/emit
  diagnostics; benign console noise (e.g. "Refused to set unsafe header") is filtered. The buffer holds up
  to 2000 entries; use the overlay's **copy all** button to grab the full trace.

This mode is local-only; keep `VITE_DEBUG_AUTOMATION` unset in committed builds. View the trace in a
terminal with `adb logcat | grep -i "\[auto"`.

**Reaching the backend from the device:**
- **Cloud (HTTPS)** — set `VITE_BACKEND_URL=https://api.yourdomain.com`. Recommended; no extra config.
- **Local backend from the Android emulator** — `VITE_BACKEND_URL=http://10.0.2.2:8080` (the emulator's
  host alias). The `android:emulator` script sets this for you.
- **Local backend from a physical device** — run `adb reverse tcp:8080 tcp:8080` and keep the default
  `http://localhost:8080`, or use your machine's LAN IP `http://192.168.x.x:8080`.
- Cleartext **HTTP** is permitted for dev via
  `app/android/app/src/main/res/xml/network_security_config.xml` (debug builds allow cleartext so any
  LAN IP works without per-IP edits). Production should always use HTTPS — point `VITE_BACKEND_URL` at
  an HTTPS backend and remove that allowance.
- The on-device backend URL lives in **`app/.env`** (`VITE_BACKEND_URL`). It's set to your Mac's LAN IP;
  if your IP changes (DHCP), update it (`ipconfig getifaddr en0`) and re-run `npm run build && npx cap sync android`.
- If a call still fails, the chat error banner now shows the **underlying cause + the URL it tried**
  (e.g. `Load failed · http://192.168.x.x:8080`) so you can tell "backend down" from "wrong host".

App identity (`appId: ai.procurecopilot.app`, `appName: Procure Copilot`) is in `app/capacitor.config.ts`.

### Order understanding: brand / variant / pack size

The `/intent` parser extracts **brand**, **variant**, and **pack size/count** in addition to qty/unit —
e.g. _"1kg india gate basmati rice 5 packets and tata lite salt 1 kg 3 packets"_ →
`India Gate · basmati · rice · 1 kg × 5 packets` and `Tata · lite · salt · 1 kg × 3 packets`. The rich
**rule parser works offline** (stub mode), and when a real key is configured the backend routes
branded/complex orders to Claude for best-effort extraction. The app shows brand/variant/pack on each
editable item card, and the platform search uses them to find the specific SKU. To enable the LLM path,
set `ANTHROPIC_API_KEY` + `ANTHROPIC_STUB_MODE=false` and **restart the backend** (a running server keeps
its old config/parser until restarted).

## Tests

```bash
cd backend && mvn test            # 93 tests — JUnit 5 + MockMvc + SSE integration
cd app && npm test                # 360 tests — Vitest + jsdom + Testing Library
cd app && npm run typecheck && npm run build
cd app && npm run test:e2e        # 10 Playwright web e2e specs (dev server + stub backend)
cd app && npm run test:e2e:android  # Appium + WebdriverIO (UiAutomator2) on-device journeys
```

> **Note:** run the backend tests with stub mode (`ANTHROPIC_STUB_MODE=true` / no key), otherwise
> `BackendEndpointsWebTest.nextActionEndpointReturnsOneAction` can fail — with a live key the `/next-action`
> grounding call hits the real model and returns a `click` instead of the stub's deterministic `type`.

The Android E2E suite (`app/e2e-android/`) and the demo APK (`npm run android:demo:build`, which builds
with `VITE_DEMO=1` + the `MockAutomationEngine`) let you exercise the full journey on an emulator without
live sites; the backend's `ANTHROPIC_STUB_MODE` provides deterministic offline reasoning for both.

## Safety posture (built-in)
- **Human-in-the-loop only** for OTP & payment — no code path auto-fills either.
- **Verifier** blocks checkout on any cart-vs-plan mismatch; **idempotency keys** prevent double-orders.
- **Secret scrubbing** before any Anthropic call; sessions/audit stay **on-device**; audit log is hash-chained.
- Operates the retailer's **own authenticated session** on their **own device**, human-like pacing, circuit breaker.

# Procure Copilot — MVP

Mobile (Android-first) agentic procurement assistant. A retailer says/types an order; the app reads
prices on **Hyperpure** and **Amazon.in** in controlled WebViews, runs a cart-split optimizer, shows
a rupee-saving split for approval, then fills both carts and **stops at OTP/payment** (human-in-the-loop).

This repo implements **Epics 0–6** of [`PROCURE_COPILOT_PLAN.md`](./PROCURE_COPILOT_PLAN.md) (the MVP).

## Layout

```
app/        Ionic 8 + Capacitor 8 + React 18 + TypeScript — the on-device app & automation engine
backend/    Spring Boot 3.4 (Java 21, Maven) — Anthropic proxy, agent brain, optimizer, registries, event store
```

### App (`app/src/core`)
- `domain/` — shared entities (money in **paise**), `PlatformId`, `Allocation`, `OrderAttempt`…
- `automation/` — **Epic 2** WebView engine: injected DOM serializer / settle-waiter / action executor,
  the Capgo bridge (+ jsdom `MockBridge`), and the perceive→reason→act loop with retry, circuit breaker,
  `verifyStepEffect`, and OTP/payment detection.
- `adapters/` — **Epic 3** Hyperpure + Amazon playbooks, selectors, recorded fixtures, engine factory + health/self-heal.
- `intent/` — **Epic 1** device-side scrubber, intent client, editable item-list model, i18n (en/hi/bn).
- `optimizer/` + `orchestrator/` — **Epic 5** event-sourced `ProcurementSession`, single-writer `Orchestrator`
  with a durable outbox, optimizer client + rupee explanation.
- `checkout/` + `audit/` — **Epic 6** Verifier gate, idempotent checkout driver, order-confirmation parser,
  and a tamper-evident on-device audit log.
- `backend/`, `secure/`, `config.ts` — backend HTTP client, secure-store seam, app config.
- `ui/pages/ProcureFlow.tsx` — the end-to-end flow controller wiring all epics behind the orchestrator.

### Backend (`backend/src/main/java/ai/procurecopilot/backend`)
- `llm/` — **Epic 0** `ClaudeService` (single entry point; stub mode for offline/CI), `SecretScrubber`.
- `optimizer/` — **Epic 4** greedy cart-split optimizer (`POST /optimize`).
- `agent/` — **Epic 1/2/6** `/intent`, `/plan`, `/next-action` (grounding), `/verify` (cart-vs-plan Verifier).
- `playbook/` — **Epic 0/3** playbook registry (`/playbooks/...`).
- `session/` — **Epic 0/5/6** durable event store + SSE (`/sessions...`).
- `telemetry/` — **Epic 0/7** step traces + audit.

## Configuration (backend env vars)

All backend config is supplied via environment variables (the Anthropic key lives **off-device** and is
never shipped to the app or logged). Defaults are in `backend/src/main/resources/application.yml`.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | _(empty)_ | Your Anthropic key. **Required for live reasoning.** Empty ⇒ stub mode. |
| `ANTHROPIC_STUB_MODE` | `true` | `true` returns deterministic offline completions (no key, good for CI/local). Set `false` for live calls. |
| `ANTHROPIC_MODEL` | `claude-opus-4-20250514` | Single strong model for all reasoning (no tiering in MVP). |
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
export ANTHROPIC_MODEL=claude-opus-4-20250514
mvn spring-boot:run                      # http://localhost:8080  (health: /actuator/health)
```

A convenient `.env` file (loaded by Docker Compose, see below) — never commit it:

```bash
# .env  (repo root)
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_STUB_MODE=false
ANTHROPIC_MODEL=claude-opus-4-20250514
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
  -e ANTHROPIC_MODEL=claude-opus-4-20250514 \
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

### Building the Android app

The WebView automation engine (opening Hyperpure/Amazon, searching, adding to cart, OTP/payment
hand-off) **only runs in a real Android WebView** — it cannot run in a desktop browser. So to see the
end-to-end automation you must run on a device or emulator and be **logged in** to your Hyperpure and
Amazon.in accounts inside the app's WebViews.

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
  fail`. Use the overlay's **copy all** button to grab the full trace for analysis.

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
cd backend && mvn test      # 77 tests — JUnit 5 + MockMvc + SSE integration
cd app && npm test          # 158 tests — Vitest + jsdom + Testing Library
cd app && npm run typecheck && npm run build
cd app && npm run test:e2e  # 10 Playwright end-to-end specs (dev server + stub backend)
```

## Safety posture (built-in)
- **Human-in-the-loop only** for OTP & payment — no code path auto-fills either.
- **Verifier** blocks checkout on any cart-vs-plan mismatch; **idempotency keys** prevent double-orders.
- **Secret scrubbing** before any Anthropic call; sessions/audit stay **on-device**; audit log is hash-chained.
- Operates the retailer's **own authenticated session** on their **own device**, human-like pacing, circuit breaker.

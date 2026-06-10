# Procure Copilot — End-to-End (Playwright) Tests

These specs run in a **real browser** (Chromium) against the **real Vite dev server** and the **real
Spring Boot backend in stub mode**. Their #1 purpose is to catch real-browser-only bugs (real
`fetch`, real DOM, real module graph) that the 155 jsdom unit tests cannot — e.g. the
`HttpBackendClient` default-`fetchImpl` binding bug (`TypeError: Failed to execute 'fetch' on
'Window': Illegal invocation`).

## What runs where

- **Frontend** — Playwright's `webServer` boots `npm run dev` (Vite) at `http://localhost:5173` and
  reuses an already-running dev server if one is up. No manual step needed.
- **Backend** — assumed to be running separately at `http://localhost:8080` in **stub mode**
  (`anthropic.stub-mode=true`, the default), which returns deterministic `/intent`, `/plan`,
  `/optimize`, `/verify` responses. CORS already allows `http://localhost:5173`.

## Start the backend (stub mode)

From the repo's `backend/` directory:

```bash
mvn spring-boot:run
# (stub mode is the default — no Anthropic key required)
```

Confirm it is up before running e2e:

```bash
curl -s http://localhost:8080/actuator/health   # -> {"status":"UP"}
```

If the backend is already running on `:8080`, just reuse it.

## Run the tests

From the `app/` directory:

```bash
npm run test:e2e        # headless
npm run test:e2e:ui     # interactive / headed UI mode
```

First-time only, install the browser binary:

```bash
npx playwright install chromium
```

## The demo seam (`/flow?demo=1`)

In production, `ProcureFlow` constructs real Capacitor WebView automation engines, which cannot run
in a plain browser. The journey specs therefore visit `/flow?demo=1`, an **explicitly opt-in** seam
(query param, impossible to trigger in a normal production visit; `VITE_DEMO=1` also works). Demo mode
swaps **only** the automation transport for a deterministic in-memory `MockAutomationEngine`
(`src/core/automation/__mocks__/MockAutomationEngine.ts`). Everything else — the orchestrator state
machine, the checkout driver, the Verifier safety gate, and the live `/intent` `/plan` `/optimize`
`/verify` backend calls — runs unchanged. The approval gate is never bypassed.

The happy-path regression spec (`chat-intent.happy.spec.ts`) uses **no mocking at all** and exercises
a real `POST /intent → 200` through the default transport.

## Specs

| Spec | Flow covered |
| --- | --- |
| `chat-intent.happy.spec.ts` | Real `POST /intent` (no mocking) — the fetch-binding regression guard |
| `chat-editing.spec.ts` | Example chip → composer, qty stepper, delete, add-item, Confirm advances |
| `full-journey.spec.ts` | Order → quote → Comparison → approve → OTP → payment → summary |
| `multi-platform-split.spec.ts` | Comparison splits across both platforms with a non-zero saving |
| `otp-handoff.spec.ts` | OTP hand-off screen + reveal/"I've done this" advance |
| `payment-handoff.spec.ts` | Payment hand-off screen (amount + trust note) + advance |
| `modify-reoptimize.spec.ts` | Modify a qty from Comparison → re-optimize → comparison updates |
| `cancel.spec.ts` | Cancel from Comparison → back to the chat surface |
| `error-path.spec.ts` | Intercepted 500 on `POST /intent` → friendly error banner, no crash |

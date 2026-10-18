# Phase 22 — Installable webapp

## Decisions

- The app is an installable PWA for desktop and tablets from 768 CSS pixels wide, hosted at the existing origin under `/webapp/`.
- Per the clarified requirement, implementation and review target `preprod`, the testing branch containing the current website/KLine work. No merge to `dev` or `main`, deployment or real-order testing is performed automatically.
- `webapp` imports the website application composition directly. It inherits every website feature and existing shared/desktop browser-safe chart implementation; there are no duplicated screens, API clients, session engines or persistence schemas.
- Double-click/double-tap opens chart trading menus. Touch-drag on the background pans; native pinch zoom remains with the chart library. Editing drawings/order lines and price picking take priority. A keyboard-accessible Chart menu button uses the latest candle/tick price. Website and desktop retain right-click by default.
- Fullscreen uses the browser Fullscreen API where supported. Installation opens a standalone app window; fullscreen rejection/absence does not block trading or installation.

## Implementation

`frontend/src/WebsiteApp.tsx` owns the shared application/provider composition. The webapp adds only its app shell, installation lifecycle, fullscreen controls, connection label, scoped offline worker and targeted tablet styles. Root workspace heights accept the shell's available-height CSS variable, with the original website/desktop height as fallback.

Shared chart components consume an optional `ChartMenuGesture` context, defaulting to `contextmenu`. The webapp supplies `doubleclick`. Gesture recognition observes pointer events without capturing/preventing background gestures, rejects drags/pinches/cancellation/long holds, and suppresses synthetic duplicate mouse menus. Existing chart-to-order routing retains exact session/pane/contract context. Lightweight Swing order-line handling accepts touch pointers in the PWA and preserves release-only callbacks and cancellation recovery. Existing nested chart menus also accept tap and keyboard activation.

Deployment uses the same `/api` and `/ai` paths as the website, with optional build-time endpoint overrides. Local Vite development proxies to localhost backend/AI services independently of the website's `.env`. There are no backend, DDB or public HTTP API changes. Build dependency versions match the website lockfile.

The production-only worker controls `/webapp/` and caches only a static offline page. It never caches account responses or trading data, intercepts API/stream traffic, queues orders, forces reloads, or claims existing clients. Updates wait until old controlled windows close. Activation removes only obsolete `tradematangi-webapp-offline-*` caches. Existing application local-storage behavior and stream/session recovery remain in use.

## Verification

Focused browser checks cover both real chart renderers, native touch panning, double-tap menus, exact contract tickets, keyboard menu access, touch line-drag release/cancellation, installation controls, fullscreen state/failure, offline launch/retry, worker scope/cache cleanup/update waiting, and authenticated portrait/landscape tablet navigation.

Existing website browser checks and desktop/shared unit tests cover the reused trading, drawing, chart-renderer, account and recovery behavior. No backend test changes are necessary because backend behavior is unchanged.

Verified on 2026-10-18:

- Webapp: **16 browser scenarios pass**, including production-build PWA lifecycle tests and real chart-library touch interactions.
- Existing website: **36 browser scenarios pass**.
- Desktop/shared: **298 unit tests pass** across 43 files.
- Webapp and website TypeScript checks/production builds pass; desktop TypeScript check passes. Vite reports the existing large-bundle advisory.
- Shell scripts and worker syntax checks pass; `git diff --check` passes.

Commands: `npm run build --prefix webapp`, `npm test --prefix webapp`; from `frontend`, `node node_modules/typescript/bin/tsc --noEmit && node node_modules/vite/bin/vite.js build` and `node node_modules/@playwright/test/cli.js test`; from `windowsapp`, `node node_modules/vitest/vitest.mjs run` and `node node_modules/typescript/bin/tsc --noEmit`.

See [webapp setup and hosting](../webapp/README.md) for startup scripts, build/test commands, nginx configuration and cache headers.

## Manual acceptance before deployment

- Install/relaunch in desktop Chromium and physical iPad Safari; check standalone storage/login behavior, both orientations, double-tap, pan, pinch and line editing.
- Verify Google sign-in and broker connection flows on the deployed HTTPS origin, including popup behavior.
- Verify live feeds, background/resume recovery and concurrent website/installed-app windows against the intended test environment. The browser connectivity label is not broker-health or order-acknowledgement evidence.
- Obtain explicit authorization before any real-order acceptance test. Deployment and merging remain manual.

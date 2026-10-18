# TradeMatangi webapp

An installable PWA at `/webapp/`. It renders `frontend/src/WebsiteApp.tsx` directly, including existing shared charts and all website features. There is no second implementation of trading, persistence or account state. Website and desktop chart-menu defaults remain unchanged.

## Local use

```bash
bash scripts/start-backend.sh
# Optional AI service: bash scripts/start-aihelper.sh
bash scripts/start-webapp.sh
```

Open `http://localhost:5174/webapp/`. Vite proxies `/api` to port 8700 and `/ai` to 8701. Copy `.env.example` to `.env.local` for overrides. Unlike the website's development config, the webapp defaults to local backend services. Dependency installation uses `npm ci --no-bin-links` for WSL compatibility. Stop only the webapp with `bash scripts/stop-webapp.sh`.

```bash
cd webapp
npm ci --no-bin-links
npm run build
npm test
```

Tests require Playwright Chromium or Google Chrome (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` overrides the executable). The tests start their own servers on ports 5174/5175, so stop the development server first. Production offline tests require a fresh build. To regenerate installation icons from the checked-in SVG, run `npm run icons`.

## Interaction

- Double-click or double-tap a chart price to open its trading menu. Opening a menu never places an order. A **Chart menu** button opens at the latest candle/tick price and also works with a keyboard.
- Touch and drag the chart background to pan. Pinch zoom continues to use the chart library. Drag an editable order/drawing line to move that line; updates retain existing release-only behavior. Drawing and price-pick modes take priority over menu recognition.
- Use **Full screen** where supported, and Escape or **Exit full screen** to leave it. Install from Chromium's app menu or Safari's Add to Home Screen for a standalone window. Browser and OS support varies; standalone does not require Fullscreen API support.
- Desktop and tablets from 768 CSS pixels wide are supported; no separate phone layout is provided.

## Hosting

Build from the whole repository: webapp imports `frontend`, `shared` and browser-safe desktop chart modules. Upload only `webapp/dist/` to the existing HTTPS origin under `/webapp/`. Keep the existing website at `/` and existing backend/AI reverse proxies at `/api` and `/ai`. Do not expose Vite as the production server.

For example, with the artifact copied to `/srv/tradematangi/webapp/`, add these locations to the existing nginx server (preserving its other locations):

```nginx
location = /webapp { return 308 /webapp/; }

location = /webapp/sw.js {
    root /srv/tradematangi;
    add_header Cache-Control "no-cache" always;
    try_files $uri =404;
}

location /webapp/assets/ {
    root /srv/tradematangi;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
}

location /webapp/ {
    root /srv/tradematangi;
    add_header Cache-Control "no-cache" always;
    try_files $uri $uri/ /webapp/index.html;
}
```

Deploy assets before HTML and retain older hashed assets while old app windows may still be open. Never return SPA HTML for missing JavaScript. Revalidate HTML, manifest, icons, offline page and worker; only hashed assets receive immutable caching. Keep HTTPS endpoint overrides free of trailing `/`; never use a production localhost AI URL.

Same-origin hosting uses the existing backend identity, browser storage and Google authorized origin. Installed-app storage sharing still depends on browser/OS behavior, so a platform may require signing in again. Verify Google and broker flows in the installed target browsers.

## Offline and updates

The production-only worker is scoped to `/webapp/`. It stores only `offline.html` under the `tradematangi-webapp-offline-*` cache prefix. API requests, streams, trading mutations and account data never enter worker caching or background queues. Existing website local-storage preferences/session recovery remain in use.

An offline launch shows a static connection page with Retry. An open app retains its workspace and the existing API/SSE recovery behavior. The connection label reports browser network availability; it does not certify backend/broker health or order acknowledgement. Closing an app window does not stop server-side trading strategies.

New workers wait for existing controlled windows to close. No `skipWaiting`, forced reload, or `clients.claim` is used. Bump the offline cache version when changing the offline page. Browser HTTP caching of ordinary application assets follows the server headers above.

## Acceptance

Automated checks cover real chart gestures, contract menu context, offline navigation/retry, cache isolation, worker scope/update waiting, install/fullscreen controls and tablet sizing. Existing website chart regressions exercise the reused trading implementation. Live brokers, Google sign-in, physical iPad installation/gestures and multi-window installed-app acceptance require manual checks before deployment. No real orders are sent by these tests.

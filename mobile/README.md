# TradeMatangi phone app (Android, landscape)

A Capacitor app for reviewing trades on a phone: Sessions and the Analysis section, one-at-a-time labeling, Stats and Habits, session videos, Browse (read-only charts) and read-only open positions. Day trading stays on the desktop, website or a tablet.

- Requirements: `docs/spec-phase24.md` ("Android phone app")
- Architecture and screen design: `docs/architecture-phone.md`
- Sprints and status: `docs/spec-phase24-android-plan.md`
- Real-phone checks: `docs/phone-manual-acceptance.md`

It reuses `shared/` and a few Tauri-free desktop modules, so changes there reach the phone. It does not mount the website app.

## Server

All data comes from the server over HTTPS. The default is `https://tradematangi.co.in` (build-time `VITE_API_BASE_URL`). The server address can be changed on the sign-in screen and in More; release builds accept `https` only. The app works against any branch the server runs: features the server lacks show "not available on this server".

Sign-in uses the Bearer flow (`/api/auth/desktop/*`), never the website's `X-User-Id`. **The server must have `DESKTOP_JWT_SECRET` set**; the repository default would let anyone forge a token.

## Develop in a browser

```bash
cd mobile
npm install --no-bin-links        # /mnt/d needs --no-bin-links
npm run dev                       # http://127.0.0.1:5176  (use a 915x412 window)
npm run typecheck && npm test     # unit tests (vitest)
npm run test:ui                   # landscape UI tests (Playwright + system Chrome)
```

In a plain browser nothing secret is stored: the refresh token only lives in memory, so reloading signs you out. The Escape key stands in for the Android back button. The UI tests mock the server and check four landscape sizes (915x412, 851x393, 740x360, 960x432).

## Build the APK

One-time setup in WSL (Linux filesystem, not `/mnt/d`): JDK 21, Node 22 or newer, and the Android SDK in `~/Android/Sdk` (`cmdline-tools`, `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`). Then:

```bash
bash scripts/build-android-phone.sh            # type-check, tests, web build, sync, debug APK
```

The APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Install it by copying the file to the phone (allow installing unknown apps), or with `adb install -r` (USB debugging on; WSL can use the Windows `adb.exe`). The same build runs in GitHub Actions (`android-phone.yml`) and uploads the debug APK as an artifact.

### Signed release build

Release builds are signed from the environment; the keystore is never committed.

```bash
export ANDROID_KEYSTORE_PATH=/path/to/release.keystore
export ANDROID_KEYSTORE_PASSWORD=... ANDROID_KEY_ALIAS=... ANDROID_KEY_PASSWORD=...
cd mobile/android && ./gradlew assembleRelease -PversionCode=2
```

In GitHub Actions add the secrets `ANDROID_KEYSTORE_B64` (base64 of the keystore), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, then run the workflow by hand with "release" ticked. Create the keystore once with `keytool -genkeypair -v -keystore release.keystore -alias tradematangi -keyalg RSA -keysize 2048 -validity 10000` and keep a backup: losing it means a new app identity.

## Native settings (Android)

Landscape only, immersive full screen, `allowBackup=false`, no cleartext traffic in release (a debug build may reach a plain-http dev server), R8 shrinking on release, refresh token in the Android Keystore. App id `in.co.tradematangi.phone`.

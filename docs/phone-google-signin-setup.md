# Phone app: Google sign-in and app lock — setup and checks

The phone app signs in with email and password, or with a Google account ("Continue with Google" on the sign-in screen). Google sign-in needs a one-time setup in Google Cloud; the server needs no change.

## How it works

1. The app opens Google's account chooser (Android Credential Manager) and asks for an ID token whose audience is the server's **Web** client ID (`client_id` under `[googlesignin]` in the server's `accesskeys.ini`; the website uses the same one).
2. Google only issues that token to an app that is registered for it: an OAuth client of type **Android** with this app's package name and signing certificate (SHA-1), in the **same Google Cloud project** as the Web client.
3. The app sends the token to `POST /api/auth/desktop/google-token` (the same route the Windows app uses). The server verifies it with Google, matches the account by email, and returns the usual access / refresh tokens.
4. A Google email the server has never seen is a **new account**: the app asks for an account name once ("has no TradeMatangi account yet") and sends it with the same token. The server cannot tell "bad token" from "new account" (both are `401`), so the app treats the first `401` without a name as the second; a `401` after a name was given is reported as "did not accept this Google sign-in".

Web client ID in the app: `mobile/src/native/googleSignIn.ts` (public value, same as the website; override with `VITE_GOOGLE_WEB_CLIENT_ID` at build time).

## One-time setup in Google Cloud

1. Open Google Cloud Console and select the project that holds the website's Google client.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Android**.
   - Package name: `in.co.tradematangi.phone` (exactly, no trailing dot or space).
   - SHA-1 certificate fingerprint: the fingerprint of the key that signs the APK you install. Debug builds from this repository (CI and `scripts/build-android-phone.sh`) are signed with the fixed debug key, see `mobile/README.md` "Fixed debug key". Print its SHA-1: `keytool -list -v -keystore ~/.android/tradematangi-debug.keystore -alias tradematangi-debug | grep SHA1`.
3. **OAuth consent screen** (Google Auth Platform → Audience): while it is in *Testing*, only the listed **test users** can sign in. Add your Google account(s), or publish the app.
4. Wait. A new Android client can take from minutes to a few hours to start working.
5. For a signed **release** build later, create a second Android client with the release keystore's SHA-1 (a Google Play upload changes the signing key again: add that SHA-1 too).

Anyone whose Google account passes the consent screen can create an account through this route, exactly as on the website. Keep the consent screen in *Testing* with named test users if you want it private.

## Errors you may see

| Message in the app | Meaning | Fix |
|---|---|---|
| "Google sign-in is not set up for this build of the app" (Credential Manager error 28444, "Developer console is not set up correctly") | No Android client matches this package + signing key, or it has not propagated yet | Check the package name and the SHA-1 of the key that signed the installed APK (`apksigner verify --print-certs app-debug.apk`), wait, retry |
| "No Google account is signed in on this phone" | The phone has no Google account | Add one in the phone settings |
| "Google Play services is missing or needs an update" | Credential Manager needs Play services | Update Play services / use a phone with Google services |
| Google says the app is blocked / access denied | Consent screen in *Testing* and the account is not a test user | Add the account as a test user |
| "The server did not accept this Google sign-in" | The server refused the token (for example the Web client ID in `accesskeys.ini` differs from the app's) | Compare `client_id` in `accesskeys.ini` with the app's Web client ID |
| Closing the chooser | Nothing is shown; you stay on the sign-in screen | — |

## App lock

More → **App lock**. When on, the app asks for the phone's fingerprint / face, or its screen lock (PIN, pattern, password), when it starts and when it comes back after more than 30 seconds in the background. Turning it on asks once, so you know it works. The lock screen has **Unlock** and **Sign out** (the way out if the phone's screen lock was removed). The switch is disabled when the phone has no screen lock. Signing out turns the lock off. The lock is a cover over the app, not encryption: the sign-in token stays in the Android Keystore as before.

## Checks on a phone

See `docs/phone-manual-acceptance.md`, section A.

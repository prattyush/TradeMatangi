import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The web bundle (dist/) is served inside the app at https://<hostname>. That origin is what a YouTube embed sees
 * as its referrer, so it must be a valid https origin. `CAP_HOSTNAME` picks it at sync time; the default is Capacitor's
 * own `localhost`. Sprint 0 spike (docs/spec-phase24-android-plan.md) decides whether a real domain is needed.
 */
const hostname = process.env.CAP_HOSTNAME?.trim() || undefined

const config: CapacitorConfig = {
  appId: 'in.co.tradematangi.phone',
  appName: 'TradeMatangi',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    ...(hostname ? { hostname } : {}),
    // Never load anything over plain http inside the app.
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    // Remote debugging of the WebView only in debug builds (Capacitor turns it on for debuggable apps itself).
    webContentsDebuggingEnabled: false,
    backgroundColor: '#0d1117',
  },
}

export default config

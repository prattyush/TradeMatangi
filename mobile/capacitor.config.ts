import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The web bundle (dist/) is served inside the app at https://<hostname>. That origin is what a YouTube embed sees as
 * its referrer, so it must be a valid https origin. The Sprint 0 device spike (docs/spec-phase24-android-plan.md)
 * showed every embed variant playing with this domain origin. The name is never looked up on the network: the app
 * answers requests for it locally. `CAP_HOSTNAME` overrides it at sync time (for example `localhost`).
 */
const hostname = process.env.CAP_HOSTNAME?.trim() || 'app.tradematangi.co.in'

const config: CapacitorConfig = {
  appId: 'in.co.tradematangi.phone',
  appName: 'TradeMatangi',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname,
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

import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.jeffkosarin.rhpnl',
  appName: 'RH P&L',
  webDir: 'dist',
  // Load the live Railway app instead of bundled assets.
  // This means no frontend rebuild is needed for updates — Railway deploys automatically.
  // IMPORTANT: this MUST be the same instance the laptop/browser uses (the one with your
  // real data). The "-805d" host is a SEPARATE server with a different/empty database, which
  // made the phone show stale prices and Net+Open P&L == Net (no open short calls there).
  server: {
    url: 'https://robinhood-pnl-tracker-production.up.railway.app',
    cleartext: false
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0f1629'
  }
}

export default config

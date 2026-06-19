import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.jeffkosarin.rhpnl',
  appName: 'RH P&L',
  webDir: 'dist',
  // Load the live Railway app instead of bundled assets.
  // This means no frontend rebuild is needed for updates — Railway deploys automatically.
  server: {
    url: 'https://robinhood-pnl-tracker-production-805d.up.railway.app',
    cleartext: false
  },
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0f1629'
  }
}

export default config

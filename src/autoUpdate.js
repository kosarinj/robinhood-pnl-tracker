// Auto-update: detect when a newer frontend build is deployed and reload to pick it up.
//
// Works without a service worker by comparing the content-hashed entry-bundle filename
// (e.g. /assets/index-BcjlFOYK.js) that THIS page booted with against the one referenced
// by the live index.html. Vite changes that hash on every build, so a mismatch means a
// new version is live.
//
// This is important for iOS Home Screen web apps, which cache the old build aggressively
// and otherwise never pick up new deploys until manually cleared.

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // also checks on focus / when the app becomes visible

function hashFrom(src) {
  if (!src) return null
  const m = String(src).match(/index-([A-Za-z0-9_-]+)\.js/)
  return m ? m[1] : null
}

// The bundle hash the running page loaded with (null in dev, where there's no hashed bundle)
function bootedHash() {
  const el = document.querySelector('script[type="module"][src*="/assets/index-"]')
  return hashFrom(el && el.getAttribute('src'))
}

async function liveHash() {
  // index.html is served no-cache; the query param defeats any intermediate cache too.
  const res = await fetch(`/index.html?_=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) return null
  const html = await res.text()
  const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)
  return hashFrom(m && m[0])
}

let booted = null
let busy = false
let reloading = false

async function check() {
  if (busy || reloading) return
  busy = true
  try {
    const live = await liveHash()
    if (live && booted && live !== booted) {
      reloading = true
      window.location.reload()
    }
  } catch {
    /* offline or transient network error — ignore and try again later */
  } finally {
    busy = false
  }
}

export function startAutoUpdate() {
  booted = bootedHash()
  if (!booted) return // dev mode or unexpected markup — do nothing (avoids reload loops)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('focus', check)
  setInterval(check, CHECK_INTERVAL_MS)
}

/**
 * Per-user view preferences.
 *
 * These used to be localStorage only, which made them per DEVICE. Several
 * change displayed P&L rather than just layout — the Cumulative P&L window,
 * manual share/price overrides, hidden tickers — so one account reported
 * different totals on a laptop, a phone browser and the iOS app, each holding
 * its own copy.
 *
 * localStorage stays as a synchronous cache so panels render instantly and keep
 * working offline, but the server is the source of truth: once its values
 * arrive they overwrite the local copy and subscribers re-read.
 */

let cache = {}          // key -> value, server values once loaded
let loaded = false
let loadingPromise = null
const listeners = new Set()

const notify = () => listeners.forEach(fn => { try { fn() } catch { /* a bad subscriber shouldn't stop the rest */ } })

export const subscribePrefs = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const prefsLoaded = () => loaded

const localRead = (key) => {
  const raw = (() => { try { return localStorage.getItem(key) } catch { return null } })()
  if (raw === null) return undefined
  try { return JSON.parse(raw) } catch {
    // Some of these predate this module and were written as bare strings —
    // ytdPanel_globalStart holds "2026-03-15". Parsing strictly would throw,
    // drop the value and silently reset the period to its default, so a raw
    // string is taken at face value instead.
    return raw
  }
}

const localWrite = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota / private mode */ }
}

/**
 * Read a preference. Synchronous by design — panels initialise state from this
 * during render, so it answers from cache or localStorage and lets the server
 * correct it later via subscribePrefs.
 */
export const getPref = (key, fallback) => {
  if (key in cache) return cache[key]
  const local = localRead(key)
  return local === undefined ? fallback : local
}

export const setPref = (key, value) => {
  cache[key] = value
  localWrite(key, value)
  // Fire and forget: the local write already happened, so a failed sync costs
  // cross-device carry-over, not the setting itself.
  fetch(`/api/preferences/${encodeURIComponent(key)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  }).catch(() => {})
  return value
}

/**
 * Pull this user's preferences and adopt them.
 *
 * Keys the server has never seen are seeded from whatever this device already
 * had, so an existing setup isn't lost the first time. That means the first
 * device to load after the upgrade defines the starting point — worth knowing
 * if two devices disagree, because the other one's values are the ones that
 * get replaced.
 */
export const loadPrefs = async (seedKeys = []) => {
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    try {
      const res = await fetch('/api/preferences', { credentials: 'include' })
      const data = await res.json()
      if (!data?.success) return
      cache = { ...(data.preferences || {}) }

      // Adopt the server's values locally so a later offline read agrees.
      Object.entries(cache).forEach(([k, v]) => localWrite(k, v))

      const toSeed = seedKeys.filter(k => !(k in cache) && localRead(k) !== undefined)
      await Promise.all(toSeed.map(async (k) => {
        const value = localRead(k)
        cache[k] = value
        try {
          await fetch(`/api/preferences/${encodeURIComponent(k)}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
          })
        } catch { /* stays local until the next load */ }
      }))

      loaded = true
      notify()
    } catch {
      // Offline or unauthenticated: localStorage carries on as before.
    } finally {
      loadingPromise = null
    }
  })()
  return loadingPromise
}

/**
 * One fetch per URL for the dashboard panels.
 *
 * The top cards, goal ring, recap, timeline, pockets and the Positions status
 * dots all want the same few endpoints. Each asks here; the first caller's
 * request is shared with everyone else for a minute, so mounting six panels
 * costs one round of requests, not six.
 */
const cache = new Map()

export const fetchShared = (url, ttlMs = 60000) => {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise
  const promise = fetch(url, { credentials: 'include' })
    .then(r => r.json())
    .catch(e => ({ success: false, error: e.message }))
  cache.set(url, { at: Date.now(), promise })
  return promise
}

export const brokerQuery = (broker) =>
  broker && broker !== 'all' ? `broker=${encodeURIComponent(broker)}` : ''

export const withQuery = (path, ...parts) => {
  const q = parts.filter(Boolean).join('&')
  return q ? `${path}?${q}` : path
}

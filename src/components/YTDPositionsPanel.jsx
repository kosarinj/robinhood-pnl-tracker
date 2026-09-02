import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '../contexts/ThemeContext'
import { getPref, setPref, subscribePrefs } from '../services/prefs'

const DEFAULT_GLOBAL_START = '2026-03-15'
const LS_GLOBAL_KEY = 'ytdPanel_globalStart'
const LS_SYMBOL_KEY = 'ytdPanel_symbolDates'
const LS_HIDDEN_KEY = 'ytdPanel_hiddenTickers'   // legacy single-broker list

// Hidden tickers are per broker: a name you don't want cluttering one account
// is often a real position at another.
const hiddenKey = (broker) => `ytdPanel_hiddenTickers_${broker || 'all'}`

// Existing hides were made when everything was Robinhood, so they carry over to
// the Robinhood and All views. Brokers added later start with nothing hidden,
// which is the point — a name hidden at one broker shouldn't vanish at another.
const loadHidden = (broker) => {
  try {
    const own = localStorage.getItem(hiddenKey(broker))
    if (own != null) return JSON.parse(own)
    const legacy = localStorage.getItem(LS_HIDDEN_KEY)
    if (legacy != null && (broker === 'robinhood' || broker === 'all')) {
      localStorage.setItem(hiddenKey(broker), legacy)
      return JSON.parse(legacy)
    }
    return []
  } catch { return [] }
}
const LS_ROWVIEW_KEY = 'ytdPanel_rowView'
const LS_DENSE_KEY   = 'ytdPanel_dense'   // compact rows
// Cost overrides are cached per broker — one shared key was how the Robinhood
// cost ended up showing on Webull rows.
const costKey = (broker) => `ytdPanel_costOverrides_${broker || 'all'}`
const colKey = (broker) => `ytdPanel_columnOrder_${broker || 'all'}`

const fmt = (n) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}

const fmtDate = (s) => {
  if (!s) return ''
  const [y, m, d] = s.split('-')
  return `${m}/${d}/${y.slice(2)}`
}

const pnlColor = (n, isDark) => {
  if (n == null || n === 0) return isDark ? '#94a3b8' : '#64748b'
  return n > 0 ? '#22c55e' : '#ef4444'
}

export default function YTDPositionsPanel({ pnlData = [], broker = 'all' }) {
  const { isDark } = useTheme()

  // The period start decides which realized P&L is counted, so it follows the
  // user as well — otherwise two devices report different totals.
  const [globalStart, setGlobalStart] = useState(() => getPref(LS_GLOBAL_KEY, DEFAULT_GLOBAL_START))
  // Compact rows. 28 columns and a long list means the limit is how much fits
  // on screen, not how much is rendered — this trades breathing room for rows.
  const [dense, setDense] = useState(() => getPref(LS_DENSE_KEY, true))
  const [asOf, setAsOf] = useState('')  // point-in-time "as of" date; '' = live
  // Horizon for the theta projection column (months ahead, underlying held flat)
  const [projectMonths, setProjectMonths] = useState(1)
  // What-if: shock every underlying by this percentage, right now. 0 = off.
  // The mirror of the projection — that moves time and holds price, this moves
  // price and holds time.
  const [scenarioMove, setScenarioMove] = useState(0)
  const SCENARIO_CHOICES = [-30, -20, -15, -10, -5, -2.5, 2.5, 5, 10, 15, 20, 30]
  // Which rows to show: everything, only names with option activity, or only
  // stocks held without options. Remembered between visits.
  const [rowView, setRowView] = useState(() => localStorage.getItem(LS_ROWVIEW_KEY) || 'all')
  const changeRowView = (v) => { setRowView(v); localStorage.setItem(LS_ROWVIEW_KEY, v) }
  const [symbolDates, setSymbolDates] = useState(() => {
    return getPref(LS_SYMBOL_KEY, {})
  })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [editingSymbol, setEditingSymbol] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [costOverrides, setCostOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem(costKey(broker)) || '{}') } catch { return {} }
  })
  const [editingCost, setEditingCost] = useState(null)
  const [costDraft, setCostDraft] = useState('')
  const [sortField, setSortField] = useState('ticker')
  const [sortDir, setSortDir] = useState('asc')
  const [livePrices, setLivePrices] = useState({})
  const [stockHoldings, setStockHoldings] = useState({})
  const [stockDebug, setStockDebug] = useState(null)
  const [search, setSearch] = useState('')
  // Hidden tickers change the totals, so they must follow the user too.
  const [hiddenTickers, setHiddenTickers] = useState(() => getPref(hiddenKey(broker), loadHidden(broker)))
  const [showHiddenList, setShowHiddenList] = useState(false)
  const [showColumnEditor, setShowColumnEditor] = useState(false)
  // "Last time RDDT was at 153, where was I?" — for a covered-call book the
  // shares are worth the same at the same price, so any difference is premium
  // and decay, which is the overlay earning its keep or not.
  const [histFor, setHistFor] = useState(null)
  const [hist, setHist] = useState({ loading: false, visits: [], band: null, error: null })

  /**
   * Previous visits to this price, priced by the SAME as-of view.
   *
   * The dates come from a lightweight lookup, but each figure is then fetched
   * from /api/options-pnl/ytd?asOf=<date> — the exact endpoint behind the as-of
   * screen, which has been checked against reality. Computing it separately is
   * what kept producing numbers that disagreed with it: first from stale
   * snapshots, then from a recomputation on a different basis. Reusing it means
   * a row here and the same date in as-of cannot differ.
   *
   * It also means Net + Open rather than Net, because that view estimates the
   * open option leg with Black-Scholes at the underlying's close on the day —
   * marked as an estimate there, and no less of one here.
   */
  // Column order follows the USER, not the device — reordering on a laptop is
  // the whole point, because dragging headers on a phone barely works.
  const [columnOrder, setColumnOrder] = useState(() => getPref(colKey(broker), []))
  const saveColumnOrder = (next) => {
    setColumnOrder(next)
    setPref(colKey(broker), next)
  }
  const [dragKey, setDragKey] = useState(null)
  const [dragOverKey, setDragOverKey] = useState(null)

  const [lastUpdated, setLastUpdated] = useState(null)
  // Ordinary tax rate reused from the Tax Center's saved plan (options + short-term
  // gains are taxed at this rate). Defaults to 24% if the Tax tab hasn't been set.
  const [taxRate] = useState(() => {
    try { const p = JSON.parse(localStorage.getItem('taxCenter_plan') || '{}'); return parseFloat(p.ordinaryRate) || 24 } catch { return 24 }
  })

  // Where to draw the popover, in viewport coordinates. Needed because it's
  // portalled out of the table and so has no positioned ancestor to sit under.
  const [histAnchor, setHistAnchor] = useState(null)
  // Per-ticker drill-down: the individual contracts behind a row, with the mark
  // each one got and where that mark came from.
  const [openRow, setOpenRow] = useState(null)
  const [rowDetail, setRowDetail] = useState({ loading: false, data: null, error: null })

  const toggleRowDetail = async (ticker) => {
    if (openRow === ticker) { setOpenRow(null); return }
    setOpenRow(ticker)
    setRowDetail({ loading: true, data: null, error: null })
    try {
      const q = broker && broker !== 'all' ? `&broker=${encodeURIComponent(broker)}` : ''
      const r = await fetch(`/api/debug-open-breakdown?ticker=${encodeURIComponent(ticker)}${q}`, { credentials: 'include' })
      const d = await r.json()
      setRowDetail(d?.error
        ? { loading: false, data: null, error: d.error }
        : { loading: false, data: d, error: null })
    } catch (e) {
      setRowDetail({ loading: false, data: null, error: 'Could not load' })
    }
  }
  const [histNow, setHistNow] = useState({ price: 0, value: null })

  const togglePriceHistory = async (ticker, price, el, nowValue) => {
    if (histFor === ticker) { setHistFor(null); setHistAnchor(null); return }
    if (!(price > 0)) return
    if (el) {
      const box = el.getBoundingClientRect()
      setHistAnchor({ top: box.bottom, right: window.innerWidth - box.right })
    }
    // Carried alongside, because the popover no longer lives inside the row and
    // can't read its values.
    setHistNow({ price, value: nowValue })
    setHistFor(ticker)
    setHist({ loading: true, visits: [], band: null, error: null })

    const effStart = symbolDates[ticker] || globalStart
    const brokerQ = broker && broker !== 'all' ? `&broker=${encodeURIComponent(broker)}` : ''

    try {
      const datesRes = await fetch(
        `/api/price-history-pnl/${encodeURIComponent(ticker)}?price=${price}&startDate=${effStart}${brokerQ}`,
        { credentials: 'include' })
      const datesData = await datesRes.json()
      if (!datesData?.success) throw new Error(datesData?.error || 'Could not load')
      const dates = datesData.visits || []
      if (dates.length === 0) {
        setHist({ loading: false, visits: [], band: datesData.band, error: null })
        return
      }

      // In parallel — each is a full as-of computation, and four in sequence is
      // a noticeable wait on a popover.
      const priced = await Promise.all(dates.map(async d => {
        try {
          const p = new URLSearchParams({ startDate: effStart, asOf: d.date })
          if (broker && broker !== 'all') p.set('broker', broker)
          const res = await fetch(`/api/options-pnl/ytd?${p}`, { credentials: 'include' })
          const data = await res.json()
          const row = (data?.byUnderlying || []).find(x => x.ticker === ticker)
          if (!row) return { ...d, netPlusOpen: null }
          // Assembled exactly as the panel's own column is.
          const stockPnl = (row.stockUnrealizedPnL || 0) + (row.stockRealizedPnL || 0)
          const net = (row.totalRealized || 0) + stockPnl
          return {
            ...d,
            netPlusOpen: Math.round((net + (row.openUnrealizedPnL || 0)) * 100) / 100,
            net: Math.round(net * 100) / 100,
            openPnl: row.openUnrealizedPnL ?? null,
            shares: row.stockPosition ?? null,
          }
        } catch {
          return { ...d, netPlusOpen: null }
        }
      }))

      setHist({ loading: false, visits: priced, band: datesData.band, error: null })
    } catch (e) {
      setHist({ loading: false, visits: [], band: null, error: e.message || 'Could not load' })
    }
  }

  const fetchData = useCallback(async (overrideGlobal, overrideSymbolDates, quiet = false) => {
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const gs = overrideGlobal ?? globalStart
      const sd = overrideSymbolDates ?? symbolDates
      const params = new URLSearchParams({ startDate: gs })
      if (Object.keys(sd).length > 0) params.set('symbolDates', JSON.stringify(sd))
      if (asOf) params.set('asOf', asOf)
      if (broker && broker !== 'all') params.set('broker', broker)
      const res = await fetch(`/api/options-pnl/ytd?${params}`, { credentials: 'include' })
      const json = await res.json()
      if (json.success) { setData(json); setLastUpdated(Date.now()) }
      else setError(json.error)
    } catch (e) {
      setError(e.message)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [globalStart, symbolDates, asOf, broker])

  useEffect(() => { fetchData() }, [])
  // Refetch when the as-of date changes (or is cleared back to live)
  useEffect(() => { fetchData(undefined, undefined, true) }, [asOf])
  // ...and when the broker tab changes. Stock holdings have to refetch too, or
  // the Shares / Avg Cost / Stock P&L columns would keep showing every broker
  // while the options columns beside them show only the selected one.
  useEffect(() => {
    fetchData(undefined, undefined, true)
    fetchStockHoldings()
    fetchCostOverrides()
    // Hidden tickers are per broker, so swap in this tab's list.
    setHiddenTickers(getPref(hiddenKey(broker), loadHidden(broker)))
    setColumnOrder(getPref(colKey(broker), []))
    setShowHiddenList(false)
    setShowColumnEditor(false)
  }, [broker])

  // The server's copy arrives after first paint; adopt it when it does so a
  // layout set on another device shows up without a reload.
  useEffect(() => subscribePrefs(() => {
    setColumnOrder(getPref(colKey(broker), []))
    setHiddenTickers(getPref(hiddenKey(broker), loadHidden(broker)))
    // The period is part of what the numbers mean, so if this user's saved one
    // differs from what this device opened with, adopt it and refetch. Guarded
    // on a real change — an unconditional refetch here would fire on every
    // preference load.
    const savedStart = getPref(LS_GLOBAL_KEY, null)
    const savedDates = getPref(LS_SYMBOL_KEY, null)
    const startChanged = savedStart && savedStart !== globalStart
    const datesChanged = savedDates && JSON.stringify(savedDates) !== JSON.stringify(symbolDates)
    if (startChanged) setGlobalStart(savedStart)
    if (datesChanged) setSymbolDates(savedDates)
    if (startChanged || datesChanged) {
      fetchData(startChanged ? savedStart : globalStart, datesChanged ? savedDates : symbolDates, true)
    }
  }), [broker, globalStart, symbolDates, fetchData])

  // Fetch stock holdings + cost overrides from server on mount.
  // Scoped to the broker tab so Shares / Avg Cost / Stock P&L match the
  // options columns beside them.
  const fetchStockHoldings = () => {
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/stock-positions-with-prices${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        setStockDebug(json)
        if (json.success && json.holdings.length > 0) {
          const map = {}
          json.holdings.forEach(h => { map[h.symbol] = h })
          setStockHoldings(map)
          const prices = {}
          json.holdings.forEach(h => { if (h.currentPrice > 0) prices[h.symbol] = h.currentPrice })
          setLivePrices(prices)
        }
      })
      .catch(e => setStockDebug({ error: e.message }))
  }

  const fetchCostOverrides = () => {
    const key = costKey(broker)
    const localData = (() => { try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} } })()
    const q = broker && broker !== 'all' ? `?broker=${encodeURIComponent(broker)}` : ''
    fetch(`/api/stock-cost-overrides${q}`, { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        if (!json.success) return
        const serverData = json.overrides || {}
        if (Object.keys(serverData).length > 0) {
          // Server has data — use it as source of truth
          setCostOverrides(serverData)
          localStorage.setItem(key, JSON.stringify(serverData))
        } else if (Object.keys(localData).length > 0 && broker && broker !== 'all') {
          // Server empty (e.g. after redeploy) but localStorage has data — restore
          // to server. Only from a single-broker tab: a merged-view cache has no
          // one broker to restore it to.
          setCostOverrides(localData)
          Object.entries(localData).forEach(([symbol, avgCost]) => {
            fetch(`/api/stock-cost-overrides/${symbol}`, {
              method: 'PUT', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ avgCost, broker })
            }).catch(() => {})
          })
        } else {
          setCostOverrides(serverData)
        }
      })
      .catch(() => {})
  }

  useEffect(() => { fetchStockHoldings(); fetchCostOverrides() }, [])

  // Auto-refresh every 2 minutes (quietly — no loading flash) and whenever the tab
  // regains focus, so prices / option marks update without clicking Refresh.
  useEffect(() => {
    const tick = () => { fetchData(undefined, undefined, true); fetchStockHoldings() }
    const iv = setInterval(tick, 120 * 1000)
    const onVis = () => { if (!document.hidden) tick() }
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(iv)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [fetchData])

  const applyGlobalStart = (date) => {
    setGlobalStart(date)
    setPref(LS_GLOBAL_KEY, date)
    fetchData(date, symbolDates)
  }

  const saveSymbolDate = (ticker, date) => {
    const updated = { ...symbolDates }
    if (!date || date === globalStart) {
      delete updated[ticker]
    } else {
      updated[ticker] = date
    }
    setSymbolDates(updated)
    setPref(LS_SYMBOL_KEY, updated)
    setEditingSymbol(null)
    fetchData(globalStart, updated)
  }

  const clearSymbolDate = (ticker) => {
    const updated = { ...symbolDates }
    delete updated[ticker]
    setSymbolDates(updated)
    setPref(LS_SYMBOL_KEY, updated)
    fetchData(globalStart, updated)
  }

  // An override belongs to one broker's shares, so it can only be set from a
  // single-broker tab. From "All brokers" there is no unambiguous target.
  const saveCostOverride = async (ticker, value) => {
    const num = parseFloat(value)
    if (!num || num <= 0) return
    if (!broker || broker === 'all') {
      setError('Pick a broker tab before editing cost. An override applies to a single broker position.')
      setEditingCost(null)
      return
    }
    const rounded = Math.round(num * 100) / 100
    const updated = { ...costOverrides, [ticker]: rounded }
    setCostOverrides(updated)
    localStorage.setItem(costKey(broker), JSON.stringify(updated))
    setEditingCost(null)
    try {
      await fetch(`/api/stock-cost-overrides/${ticker}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avgCost: rounded, broker })
      })
      fetchData(undefined, undefined, true)
    } catch (e) {
      console.error('Failed to persist cost override:', e)
    }
  }

  const clearCostOverride = async (ticker) => {
    if (!broker || broker === 'all') {
      setError('Pick a broker tab before clearing cost. An override applies to a single broker position.')
      setEditingCost(null)
      return
    }
    const updated = { ...costOverrides }
    delete updated[ticker]
    setCostOverrides(updated)
    localStorage.setItem(costKey(broker), JSON.stringify(updated))
    setEditingCost(null)
    try {
      await fetch(`/api/stock-cost-overrides/${ticker}?broker=${encodeURIComponent(broker)}`,
        { method: 'DELETE', credentials: 'include' })
      fetchData(undefined, undefined, true)
    } catch (e) {
      console.error('Failed to delete cost override:', e)
    }
  }

  const hideTicker = (t) => {
    const updated = [...new Set([...hiddenTickers, t])]
    setHiddenTickers(updated)
    setPref(hiddenKey(broker), updated)
  }

  const restoreTicker = (t) => {
    const updated = hiddenTickers.filter(x => x !== t)
    setHiddenTickers(updated)
    setPref(hiddenKey(broker), updated)
    if (updated.length === 0) setShowHiddenList(false)
  }

  const restoreAllTickers = () => {
    setHiddenTickers([])
    setPref(hiddenKey(broker), [])
    setShowHiddenList(false)
  }

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const headerBg = isDark ? '#151929' : '#f8fafc'
  const rowHover = isDark ? '#252d3d' : '#f8fafc'

  // Build a fallback stock lookup from pnlData (dashboard data) for when server-side data is missing
  const pnlLookup = {}
  pnlData.forEach(p => {
    if (!p.isOption && p.symbol) {
      pnlLookup[p.symbol] = {
        position: p.real?.position ?? p.avgCost?.position ?? 0,
        avgCost: p.real?.avgCostBasis ?? p.avgCost?.avgCostBasis ?? 0,
        currentPrice: p.currentPrice ?? 0,
        unrealizedPnL: p.real?.unrealizedPnL ?? 0
      }
    }
  })

  const q = search.trim().toUpperCase()
  const hiddenSet = new Set(hiddenTickers)
  // Rows now include stocks held without any options (hasOptions false). The
  // view filter narrows to one kind; totals below follow whatever is shown.
  const rows = (data?.byUnderlying || []).filter(r =>
    !hiddenSet.has(r.ticker) &&
    (!q || (r.ticker || '').toUpperCase().includes(q)) &&
    (rowView === 'all' ||
     (rowView === 'options' && r.hasOptions) ||
     (rowView === 'stock' && !r.hasOptions)))
  const stockOnlyCount = (data?.byUnderlying || []).filter(r => !r.hasOptions).length
  const sorted = [...rows].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1
    const av = a[sortField], bv = b[sortField]
    if (typeof av === 'string' || typeof bv === 'string') {
      return mul * String(av ?? '').localeCompare(String(bv ?? ''))
    }
    return mul * ((av ?? 0) - (bv ?? 0))
  })

  const totals = rows.reduce((acc, r) => {
    // In as-of mode ignore live holdings/prices so the endpoint's historical values win.
    const sh = asOf ? null : stockHoldings[r.ticker]
    const fb = asOf ? null : pnlLookup[r.ticker]
    const pos = (sh?.position > 0 ? sh.position : null) ?? (fb?.position > 0 ? fb.position : null) ?? (r.stockPosition > 0 ? r.stockPosition : null)
    const computedCost = (sh?.avgCost > 0 ? sh.avgCost : null) ?? (fb?.avgCost > 0 ? fb.avgCost : null) ?? (r.stockAvgCost > 0 ? r.stockAvgCost : null)
    // The server already blended the override with post-start buys and booked
    // realized against the same basis; recomputing from the flat override here
    // would put one row's two halves on different bases.
    const avgCost = (r.stockCostUsed > 0 ? r.stockCostUsed : null) || costOverrides[r.ticker] || computedCost
    const price = (sh?.currentPrice > 0 ? sh.currentPrice : null) ?? (!asOf && livePrices[r.ticker] > 0 ? livePrices[r.ticker] : null) ?? (r.stockCurrentPrice > 0 ? r.stockCurrentPrice : null)
    const stockUnrealized = (pos > 0 && avgCost > 0 && price > 0)
      ? Math.round(pos * (price - avgCost) * 100) / 100
      : 0
    const stockPnL = stockUnrealized + (r.stockRealizedPnL || 0)
    // Portfolio-wide what-if: every underlying shocked by the same percentage
    // at once. Realized stays put; only the open side moves.
    const scPrice = (scenarioMove !== 0 && price > 0) ? price * (1 + scenarioMove / 100) : null
    const scStockPnL = scPrice
      ? ((pos > 0 && avgCost > 0) ? Math.round(pos * (scPrice - avgCost) * 100) / 100 : 0) + (r.stockRealizedPnL || 0)
      : stockPnL
    const scOpen = scenarioMove !== 0
      ? (r.openScenario?.[scenarioMove] ?? r.openUnrealizedPnL ?? 0)
      : (r.openUnrealizedPnL || 0)
    return {
      scenarioStockPnL: acc.scenarioStockPnL + scStockPnL,
      scenarioOpen: acc.scenarioOpen + scOpen,
      scenarioNetPlusOpen: acc.scenarioNetPlusOpen + (r.totalRealized || 0) + scStockPnL + scOpen,
      realizedShortCalls: acc.realizedShortCalls + (r.realizedShortCalls || 0),
      realizedLongCalls: acc.realizedLongCalls + (r.realizedLongCalls || 0),
      realizedShortPuts: acc.realizedShortPuts + (r.realizedShortPuts || 0),
      realizedLongPuts: acc.realizedLongPuts + (r.realizedLongPuts || 0),
      totalRealized: acc.totalRealized + (r.totalRealized || 0),
      taxableRealized: acc.taxableRealized + (r.totalRealized || 0) + (r.stockRealizedPnL || 0),
      openPremium: acc.openPremium + (r.openPremium || 0),
      openUnrealizedPnL: acc.openUnrealizedPnL + (r.openUnrealizedPnL || 0),
      openProjectedPnL: acc.openProjectedPnL + (r.openProjected?.[projectMonths]?.pnl ?? r.openUnrealizedPnL ?? 0),
      // stockUnrealizedPnL carries realized too and feeds Net and the vs-Stock%
      // footer; stockUnrealizedOnly is what the Stock P&L column foots to.
      stockUnrealizedPnL: acc.stockUnrealizedPnL + stockPnL,
      stockUnrealizedOnly: acc.stockUnrealizedOnly + stockUnrealized,
      net: acc.net + (r.totalRealized || 0) + stockPnL,
      dayPnl: acc.dayPnl + (r.dayPnl || 0),
      // Summed independently of dayPnl, which is withheld entirely when a leg
      // can't be priced. A half that IS known still belongs in its own total.
      openExitPnL: acc.openExitPnL + (r.openExitPnL || 0),
      stockRealizedAll: acc.stockRealizedAll + (r.stockRealizedAll || 0),
      dayStockPnl: acc.dayStockPnl + (r.dayStockPnl || 0),
      dayOptionPnl: acc.dayOptionPnl + (r.dayOptionPnl || 0),
      costBasis: acc.costBasis + ((pos > 0 && avgCost > 0) ? pos * avgCost : 0)
    }
  }, { scenarioStockPnL: 0, scenarioOpen: 0, scenarioNetPlusOpen: 0, openExitPnL: 0, stockRealizedAll: 0, dayStockPnl: 0, dayOptionPnl: 0, realizedShortCalls: 0, realizedLongCalls: 0, realizedShortPuts: 0, realizedLongPuts: 0, totalRealized: 0, taxableRealized: 0, openPremium: 0, openUnrealizedPnL: 0, openProjectedPnL: 0, stockUnrealizedPnL: 0, stockUnrealizedOnly: 0, net: 0, dayPnl: 0, costBasis: 0 })

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span style={{ opacity: 0.3, fontSize: '10px' }}> ↕</span>
    return <span style={{ fontSize: '10px' }}> {sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const padCell = dense ? '3px 12px' : '10px 12px'
  const padPin  = dense ? '3px 4px'  : '10px 4px'

  const thStyle = (field) => ({
    padding: dense ? '5px 12px' : '10px 12px', textAlign: 'right', fontSize: '11px', fontWeight: '600',
    color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
    background: sortField === field ? (isDark ? '#1a2035' : '#f0f4ff') : headerBg,
    borderBottom: `2px solid ${border}`,
    // Keeps the column names in view through a long list. The page scrolls, not
    // a nested box, so this pins to the viewport rather than a container.
    position: 'sticky', top: 0, zIndex: 1,
  })


  // ── Column model ────────────────────────────────────────────────────────
  // Header, body and footer all map over ONE array, so their cell counts can't
  // drift apart — they were three hand-maintained lists of 21, 23 and 19 cells,
  // which is how a new column could silently misalign the whole table.
  //
  // Ticker is pinned: its sticky-left positioning depends on being first, and
  // that frozen column is what makes 20-odd columns of sideways scroll usable.

  // Everything a row's cells need, computed once per row instead of per cell.
  const rowCtx = (row, i) => {
    const sh = asOf ? null : stockHoldings[row.ticker]
    const fb = asOf ? null : pnlLookup[row.ticker]
    const pos = (sh?.position > 0 ? sh.position : null) ?? (fb?.position > 0 ? fb.position : null) ?? (row.stockPosition > 0 ? row.stockPosition : null)
    const computedCost = (sh?.avgCost > 0 ? sh.avgCost : null) ?? (fb?.avgCost > 0 ? fb.avgCost : null) ?? (row.stockAvgCost > 0 ? row.stockAvgCost : null)
    const hasManualCost = !!costOverrides[row.ticker]
    const avgCost = (row.stockCostUsed > 0 ? row.stockCostUsed : null) || costOverrides[row.ticker] || computedCost
    const effectiveCost = (pos > 0 && avgCost > 0)
      ? Math.round((avgCost - (row.totalRealized || 0) / pos) * 100) / 100
      : null
    const price = (sh?.currentPrice > 0 ? sh.currentPrice : null) ?? (!asOf && livePrices[row.ticker] > 0 ? livePrices[row.ticker] : null) ?? (row.stockCurrentPrice > 0 ? row.stockCurrentPrice : null)
    const stockUnrealized = (pos > 0 && avgCost > 0 && price > 0) ? Math.round(pos * (price - avgCost) * 100) / 100 : 0
    const stockRealized = row.stockRealizedPnL || 0
    const hasStock = (pos > 0 && avgCost > 0 && price > 0) || row.stockRealizedPnL != null
    const stockPnl = hasStock ? Math.round((stockUnrealized + stockRealized) * 100) / 100 : null
    const net = Math.round(((row.totalRealized || 0) + (stockPnl || 0)) * 100) / 100
    const netPlusOpen = Math.round((net + (row.openUnrealizedPnL || 0)) * 100) / 100
    const costBasis = (pos > 0 && avgCost > 0) ? pos * avgCost : null
    const returnPct = (costBasis && costBasis > 0) ? Math.round((netPlusOpen / costBasis) * 1000) / 10 : null
    const vsStockPct = (stockPnl != null && stockPnl !== 0) ? Math.round(((netPlusOpen - stockPnl) / Math.abs(stockPnl)) * 1000) / 10 : null
    const taxableRealized = (row.totalRealized || 0) + (row.stockRealizedPnL || 0)

    // ── What-if ──
    // Shares reprice linearly, so the stock side is shifted here rather than
    // fetched. Options come from the server, which repriced each contract with
    // Black–Scholes at the shocked underlying. Realized P&L is untouched: it's
    // already banked and a price move can't reach it.
    let sc = null
    if (scenarioMove !== 0) {
      const scPrice = price > 0 ? price * (1 + scenarioMove / 100) : null
      const scStockUnrealized = (pos > 0 && avgCost > 0 && scPrice > 0)
        ? Math.round(pos * (scPrice - avgCost) * 100) / 100
        : 0
      const scStockPnl = hasStock ? Math.round((scStockUnrealized + stockRealized) * 100) / 100 : null
      // Falls back to today's open P&L when a ticker has no repriced option —
      // no contracts, or no vol could be backed out of its mark.
      const scOpen = row.openScenario?.[scenarioMove] ?? row.openUnrealizedPnL ?? 0
      const scNetPlusOpen = Math.round((((row.totalRealized || 0) + (scStockPnl || 0)) + scOpen) * 100) / 100
      sc = {
        price: scPrice,
        stockPnl: scStockPnl,
        open: scOpen,
        hasOptionModel: row.openScenario?.[scenarioMove] != null,
        netPlusOpen: scNetPlusOpen,
        delta: Math.round((scNetPlusOpen - netPlusOpen) * 100) / 100,
      }
    }

    return {
      sc,
      i, pos, hasManualCost, avgCost, effectiveCost, price,
      stockUnrealized, stockRealized, stockPnl, net, netPlusOpen, costBasis,
      returnPct, vsStockPct, optionsHelped: stockPnl != null && netPlusOpen >= stockPnl,
      estTax: Math.round(taxableRealized * taxRate) / 100,
      isCostEditing: editingCost === row.ticker,
      isEditing: editingSymbol === row.ticker,
      effectiveDate: symbolDates[row.ticker] || globalStart,
      hasOverride: !!symbolDates[row.ticker],
      tickerBg: i % 2 === 0 ? surface : (isDark ? '#1a2035' : '#fafbff'),
      proj: row.openProjected?.[projectMonths],
    }
  }

  const ALL_COLUMNS = [
    { key: 'ticker', label: 'Ticker', pinned: true, sort: 'ticker', align: 'left' },

    { key: 'realizedShortCalls', label: 'Short Calls', sort: 'realizedShortCalls', title: 'Realized P&L from short calls (covered calls sold)',
      cell: (r) => <span style={{ color: pnlColor(r.realizedShortCalls, isDark), fontWeight: 600 }}>{fmt(r.realizedShortCalls)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.realizedShortCalls, isDark), fontWeight: 700 }}>{fmt(t.realizedShortCalls)}</span> },

    { key: 'realizedLongCalls', label: 'Long Calls', sort: 'realizedLongCalls', title: 'Realized P&L from long calls (calls bought)',
      cell: (r) => <span style={{ color: pnlColor(r.realizedLongCalls, isDark), fontWeight: 600 }}>{fmt(r.realizedLongCalls)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.realizedLongCalls, isDark), fontWeight: 700 }}>{fmt(t.realizedLongCalls)}</span> },

    { key: 'realizedShortPuts', label: 'Short Puts', sort: 'realizedShortPuts', title: 'Realized P&L from short puts (cash-secured puts)',
      cell: (r) => <span style={{ color: pnlColor(r.realizedShortPuts, isDark), fontWeight: 600 }}>{fmt(r.realizedShortPuts)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.realizedShortPuts, isDark), fontWeight: 700 }}>{fmt(t.realizedShortPuts)}</span> },

    { key: 'realizedLongPuts', label: 'Long Puts', sort: 'realizedLongPuts', title: 'Realized P&L from long puts (protective puts bought)',
      cell: (r) => <span style={{ color: pnlColor(r.realizedLongPuts, isDark), fontWeight: 600 }}>{fmt(r.realizedLongPuts)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.realizedLongPuts, isDark), fontWeight: 700 }}>{fmt(t.realizedLongPuts)}</span> },

    { key: 'totalRealized', label: 'Options Total', sort: 'totalRealized',
      cell: (r) => <span style={{ color: pnlColor(r.totalRealized, isDark), fontWeight: 700, fontSize: 14 }}>{fmt(r.totalRealized)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.totalRealized, isDark), fontWeight: 700, fontSize: 15 }}>{fmt(t.totalRealized)}</span> },

    { key: 'estTax', label: 'Est. Tax',
      title: 'Estimated tax on this year’s REALIZED gains (options + stock sold) at your ordinary rate from the Tax tab. Unrealized gains aren’t taxed until sold; losses show as a negative (tax benefit).',
      cell: (r, c) => <span title={`(${fmt(r.totalRealized)} options + ${fmt(r.stockRealizedPnL || 0)} stock realized) × ${taxRate}% = ${fmt(c.estTax)}`}
        style={{ fontWeight: 600, color: c.estTax > 0 ? '#ef4444' : c.estTax < 0 ? '#22c55e' : textMid }}>{fmt(c.estTax)}</span>,
      foot: (t) => {
        const ft = Math.round(t.taxableRealized * taxRate) / 100
        return <span title={`Estimated tax on all realized gains this year at ${taxRate}%`}
          style={{ fontWeight: 700, fontSize: 15, color: ft > 0 ? '#ef4444' : ft < 0 ? '#22c55e' : textMid }}>{fmt(ft)}</span>
      } },

    { key: 'openPremium', label: 'Open Premium', sort: 'openPremium',
      title: 'Credit collected on currently-open SHORT options (covered calls / cash-secured puts). Long options are not netted in.',
      cell: (r) => <span style={{ color: pnlColor(r.openPremium, isDark), fontWeight: 500 }}>{fmt(r.openPremium)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.openPremium, isDark), fontWeight: 700 }}>{fmt(t.openPremium)}</span> },

    { key: 'openUnrealizedPnL', label: 'Open P&L', sort: 'openUnrealizedPnL',
      title: 'Unrealized P&L on open short options: premium collected minus current cost to buy them back',
      cell: (r) => <span title={
          (r.openUnrealizedPnL != null ? 'Premium collected/paid − current cost to close open options' : 'No live option price available')
          + (r.openMarkBasis === 'model' ? ' · MODELLED — no market price for these contracts, so this is a Black-Scholes estimate and can differ from your broker'
             : r.openMarkBasis === 'mixed' ? ' · some legs modelled, some from real market prices'
             : r.openMarkBasis === 'market' ? ' · from real market prices' : '')}
        style={{ fontWeight: 700, color: pnlColor(r.openUnrealizedPnL, isDark) }}>
        {r.openUnrealizedPnL != null ? `${asOf ? '~' : ''}${fmt(r.openUnrealizedPnL)}` : '—'}
        {r.openMarkBasis === 'model' && <span style={{ fontSize: 10, color: '#f59e0b' }}> ~est</span>}
        {r.openMarkBasis === 'mixed' && <span style={{ fontSize: 10, color: '#f59e0b' }}> ~</span>}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.openUnrealizedPnL, isDark), fontWeight: 700 }}>{fmt(t.openUnrealizedPnL)}</span> },

    { key: 'theta', label: 'Theta',
      title: 'Estimated Open P&L if the stock doesn’t move — decay only. Volatility is held constant and backed out of today’s mark. Contracts expiring before then settle at intrinsic.',
      header: () => (<>
        <div>Theta {projectMonths}M</div>
        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', marginTop: 3 }}>
          {[1, 2, 3].map(m => (
            <span key={m} onClick={e => { e.stopPropagation(); setProjectMonths(m) }}
              style={{ cursor: 'pointer', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, lineHeight: 1.4,
                background: projectMonths === m ? 'var(--accent)' : 'transparent',
                color: projectMonths === m ? 'var(--accentText)' : textMid,
                border: `1px solid ${projectMonths === m ? 'var(--accent)' : 'transparent'}` }}>{m}M</span>
          ))}
        </div>
      </>),
      cell: (r, c) => {
        if (!c.proj) return <span style={{ color: isDark ? '#475569' : '#cbd5e1' }}>{'—'}</span>
        const gain = c.proj.pnl - (r.openUnrealizedPnL || 0)
        const allExpired = c.proj.totalLegs > 0 && c.proj.expiredLegs === c.proj.totalLegs
        return (
          <span title={`In ${projectMonths} month(s) with ${r.ticker} unchanged: ${fmt(c.proj.pnl)} (${gain >= 0 ? '+' : ''}${fmt(gain)} of decay).`}
            style={{ fontWeight: 700, color: pnlColor(c.proj.pnl, isDark) }}>
            {fmt(c.proj.pnl)}
            <div style={{ fontSize: 10, fontWeight: 500, color: textMid }}>
              {gain >= 0 ? '+' : ''}{fmt(gain)}
              {c.proj.expiredLegs > 0 && <span title={allExpired ? 'All contracts expired by then' : 'Some expired by then'}>{' '}{allExpired ? '✓' : `✓${c.proj.expiredLegs}`}</span>}
            </div>
          </span>
        )
      },
      foot: (t) => (
        <span title="Total Open P&L at the selected horizon with every stock unchanged."
          style={{ color: pnlColor(t.openProjectedPnL, isDark), fontWeight: 700 }}>
          {fmt(t.openProjectedPnL)}
          <div style={{ fontSize: 10, fontWeight: 500, color: textMid }}>
            {t.openProjectedPnL - t.openUnrealizedPnL >= 0 ? '+' : ''}{fmt(t.openProjectedPnL - t.openUnrealizedPnL)}
          </div>
        </span>) },

    { key: 'shares', label: 'Shares', title: 'Shares held', borderLeft: '1px',
      cell: (r, c) => <span style={{ color: textMid }}>{c.pos != null && c.pos > 0 ? c.pos.toLocaleString() : '—'}</span> },

    { key: 'avgCost', label: 'Avg Cost', title: 'Average cost per share',
      cell: (r, c) => c.isCostEditing ? (
        <span style={{ display: 'flex', gap: 3, justifyContent: 'flex-end', alignItems: 'center' }}>
          <input type="number" step="0.01" value={costDraft} onChange={e => setCostDraft(e.target.value)} autoFocus
            onKeyDown={e => { if (e.key === 'Enter') saveCostOverride(r.ticker, costDraft); if (e.key === 'Escape') setEditingCost(null) }}
            style={{ width: 72, padding: '2px 5px', borderRadius: 4, border: `1px solid ${border}`, background: surface, color: text, fontSize: 12, textAlign: 'right' }} />
          <button onClick={() => saveCostOverride(r.ticker, costDraft)} style={{ padding: '2px 6px', borderRadius: 4, border: 'none', background: '#22c55e', color: '#fff', fontSize: 11, cursor: 'pointer' }}>{'✓'}</button>
          <button onClick={() => setEditingCost(null)} style={{ padding: '2px 6px', borderRadius: 4, border: 'none', background: '#94a3b8', color: '#fff', fontSize: 11, cursor: 'pointer' }}>{'✗'}</button>
          {c.hasManualCost && <button onClick={() => clearCostOverride(r.ticker)} style={{ padding: '2px 6px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Reset</button>}
        </span>
      ) : (
        <button onClick={() => { setEditingCost(r.ticker); setCostDraft(c.avgCost?.toFixed(2) || '') }}
          title={c.hasManualCost ? `Manual override: ${fmt(c.avgCost)} (click to edit)` : `Computed: ${c.avgCost ? fmt(c.avgCost) : '—'} (click to override)`}
          style={{ background: 'transparent', border: `1px solid ${c.hasManualCost ? '#f59e0b' : 'transparent'}`, padding: '2px 6px', borderRadius: 4,
            cursor: 'pointer', color: c.hasManualCost ? '#f59e0b' : textMid, fontSize: 12, fontWeight: c.hasManualCost ? 600 : 400 }}>
          {c.avgCost ? fmt(c.avgCost) : '—'}{c.hasManualCost ? ' ✎' : ''}
        </button>) },

    { key: 'effCost', label: 'Eff. Cost',
      title: 'Effective cost per share after options income = Avg Cost − (realized Options Total ÷ shares). Uses booked option P&L only.',
      cell: (r, c) => <span title={c.effectiveCost != null ? `Avg cost ${fmt(c.avgCost)} − realized options ${fmt(r.totalRealized)} ÷ ${c.pos?.toLocaleString()} sh` : 'Needs shares held + an avg cost'}
        style={{ fontWeight: 600, color: c.effectiveCost == null ? textMid : c.effectiveCost < c.avgCost ? '#22c55e' : c.effectiveCost > c.avgCost ? '#ef4444' : text }}>
        {c.effectiveCost != null ? fmt(c.effectiveCost) : '—'}</span> },

    { key: 'stockPrice', label: 'Stock Price', title: 'Current stock price',
      cell: (r, c) => <span style={{ color: text }}>{c.price ? fmt(c.price) : '—'}</span> },

    // Unrealized only. Realized has its own column immediately to the right, so
    // the table still sums to Net — just in three visible terms rather than two:
    // Stock P&L + Stock Realized + Options Total. Folding realized in here read
    // as double-counting on any name sold and bought back.
    { key: 'stockPnL', label: 'Stock P&L', sort: 'stockUnrealizedPnL',
      title: 'Unrealized P&L on shares still held. Gains already booked are in Stock Realized. Net = Stock P&L + Stock Realized + Options Total.',
      cell: (r, c) => <span title={`Unrealized: ${fmt(c.stockUnrealized)} · Realized (next column): ${fmt(c.stockRealized)}`}
        style={{ fontWeight: 700, color: pnlColor(c.stockUnrealized, isDark) }}>{c.stockPnl != null ? fmt(c.stockUnrealized) : '—'}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.stockUnrealizedOnly, isDark), fontWeight: 700 }}>{fmt(t.stockUnrealizedOnly)}</span> },

    { key: 'stockRealizedAll', label: 'Stock Realized', sort: 'stockRealizedAll', borderLeft: '1px',
      title: 'Booked gains and losses from shares actually sold, whether or not the position is still open. Part of Net: Net = Stock P&L + Stock Realized + Options Total.',
      cell: (r) => r.stockRealizedAll == null || r.stockRealizedAll === 0
        ? <span style={{ color: textMid }}>—</span>
        : (
          <span title={r.stockPosition > 0
              ? 'Already banked, and counted in Net.'
              : 'Position fully closed — also counted in Net.'}
            style={{ fontWeight: 600, color: pnlColor(r.stockRealizedAll, isDark) }}>
            {fmt(r.stockRealizedAll)}
            {r.stockPosition > 0 && <span style={{ fontSize: 10, color: textMid }}> banked</span>}
          </span>
        ),
      foot: (t) => <span style={{ color: pnlColor(t.stockRealizedAll, isDark), fontWeight: 700 }}>
        {fmt(t.stockRealizedAll)}</span> },

    { key: 'net', label: 'Net', sort: 'net', borderLeft: '2px', title: 'Stock P&L (unrealized) + Stock Realized + Options Total.',
      cell: (r, c) => <span style={{ fontWeight: 700, fontSize: 14, color: pnlColor(c.net, isDark) }}>{fmt(c.net)}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.net, isDark), fontWeight: 700, fontSize: 15 }}>{fmt(t.net)}</span> },

    { key: 'netPlusOpen', label: 'Net + Open P&L', borderLeft: '1px', title: 'Net + Open P&L — marks open short options to market on top of Net. Click a value to see previous times this stock was at the same price.',
      // The popover is NOT rendered here — it goes through a portal to
      // document.body, below. The sticky ticker column is position:sticky with
      // a z-index, which makes it its own stacking context, and nothing painted
      // inside the table can be layered above it however high its z-index. The
      // only reliable fix is to leave the table.
      cell: (r, c) => (
        <span
          onClick={e => togglePriceHistory(r.ticker, c.price, e.currentTarget, c.netPlusOpen)}
          title={`Net (${fmt(c.net)}) + Open P&L (${r.openUnrealizedPnL != null ? fmt(r.openUnrealizedPnL) : '—'})`
            + (c.price > 0 ? ' · click for previous visits to this price' : '')}
          style={{ fontWeight: 700, fontSize: 14, color: pnlColor(c.netPlusOpen, isDark),
                   cursor: c.price > 0 ? 'pointer' : 'default',
                   borderBottom: c.price > 0 ? `1px dotted ${border}` : 'none' }}>
          {fmt(c.netPlusOpen)}
        </span>
      ),
      foot: (t) => <span style={{ color: pnlColor(t.net + t.openUnrealizedPnL, isDark), fontWeight: 700, fontSize: 15 }}>{fmt(t.net + t.openUnrealizedPnL)}</span> },

    // What-if columns. Present only while a move is selected, so the table is
    // unchanged when it's off.
    ...(scenarioMove === 0 ? [] : [
      { key: 'scenarioNet', label: `Net+Open @ ${scenarioMove > 0 ? '+' : ''}${scenarioMove}%`, borderLeft: '2px',
        title: `Net + Open P&L if this stock moved ${scenarioMove > 0 ? '+' : ''}${scenarioMove}% right now. Shares reprice directly; open options are repriced with Black–Scholes at the new underlying, holding time and implied vol fixed. Realized P&L is already banked and doesn't move.`,
        cell: (r, c) => c.sc == null ? <span style={{ color: textMid }}>—</span> : (
          <span title={`Stock ${c.sc.stockPnl != null ? fmt(c.sc.stockPnl) : '—'} + options ${fmt(c.sc.open)}` +
              (c.sc.hasOptionModel ? '' : ' (options not repriced — no vol from its mark; today\'s value carried over)')}
            style={{ fontWeight: 700, fontSize: 14, color: pnlColor(c.sc.netPlusOpen, isDark) }}>
            {fmt(c.sc.netPlusOpen)}
            {!c.sc.hasOptionModel && r.openUnrealizedPnL != null && <span style={{ fontSize: 10, color: '#f59e0b' }}> ~</span>}
          </span>
        ),
        foot: (t) => <span style={{ color: pnlColor(t.scenarioNetPlusOpen, isDark), fontWeight: 700, fontSize: 15 }}>{fmt(t.scenarioNetPlusOpen)}</span> },

      { key: 'scenarioDelta', label: 'Δ vs now', borderLeft: '1px',
        title: 'Change from where the position stands today. This is the part the move is responsible for.',
        cell: (r, c) => c.sc == null ? <span style={{ color: textMid }}>—</span> : (
          <span style={{ fontWeight: 700, color: pnlColor(c.sc.delta, isDark) }}>
            {c.sc.delta >= 0 ? '+' : ''}{fmt(c.sc.delta)}
          </span>
        ),
        foot: (t) => {
          const d = Math.round((t.scenarioNetPlusOpen - (t.net + t.openUnrealizedPnL)) * 100) / 100
          return <span style={{ color: pnlColor(d, isDark), fontWeight: 700, fontSize: 15 }}>{d >= 0 ? '+' : ''}{fmt(d)}</span>
        } },
    ]),

    { key: 'returnPct', label: 'Return %', borderLeft: '1px',
      title: 'Total return = (Net + Open P&L) ÷ cost basis of the shares.',
      cell: (r, c) => <span title={c.returnPct == null ? 'No open shares to compute a return on' : `On the ${fmt(c.costBasis)} cost basis`}
        style={{ fontWeight: 700, color: c.returnPct == null ? textMid : pnlColor(c.returnPct, isDark) }}>
        {c.returnPct != null ? `${c.returnPct >= 0 ? '+' : ''}${c.returnPct.toFixed(1)}%` : '—'}</span>,
      foot: (t) => {
        const npo = t.net + t.openUnrealizedPnL
        const ret = t.costBasis > 0 ? Math.round((npo / t.costBasis) * 1000) / 10 : null
        return <span style={{ fontWeight: 700, fontSize: 15, color: ret == null ? textMid : pnlColor(ret, isDark) }}>
          {ret != null ? `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%` : '—'}</span>
      } },

    { key: 'dayPnl', label: 'Day P&L', sort: 'dayPnl', borderLeft: '1px',
      title: 'Today’s mark-to-market move: shares × stock move since yesterday’s close, plus open options.',
      cell: (r) => <span title={r.dayPnl != null
          ? `Stock ${r.dayStockPnl != null ? fmt(r.dayStockPnl) : '—'} + options ${r.dayOptionPnl != null ? fmt(r.dayOptionPnl) : '—'}` +
            (r.dayOptionBasis === 'market' ? ' · option move from real prints at both ends'
             : r.dayOptionBasis === 'model' ? ' · option move MODELLED (no market print both ends) — an estimate of the move, not the move'
             : r.dayOptionBasis === 'mixed' ? ' · some legs modelled, some from real prints'
             : '')
          : r.dayIncomplete
            ? 'No daily stock price for this name, so the day can\'t be reported. Showing the option side alone would flip the sign on a down day — the shares fall while short options gain.'
            : 'No prior-day close available yet'}
        style={{ fontWeight: 700, color: pnlColor(r.dayPnl, isDark) }}>
        {r.dayPnl != null ? `${r.dayPnl >= 0 ? '+' : ''}${fmt(r.dayPnl)}` : '—'}
        {r.dayIncomplete && <span style={{ fontSize: 10, color: '#f59e0b' }}> no px</span>}
        {/* Shown but not whole — the total is here, one leg just isn't in it. */}
        {r.dayPartial && <span style={{ fontSize: 10, color: '#f59e0b' }}
          title="At least one option leg had no usable move, so this total is incomplete."> partial</span>}
        {r.dayOptionBasis === 'model' && <span style={{ fontSize: 10, color: '#f59e0b' }}> ~</span>}</span>,
      foot: (t) => <span style={{ color: pnlColor(t.dayPnl, isDark), fontWeight: 700, fontSize: 15 }}>{t.dayPnl != null ? `${t.dayPnl >= 0 ? '+' : ''}${fmt(t.dayPnl)}` : '—'}</span> },

    { key: 'openExitPnL', label: 'Close Now', sort: 'openExitPnL', borderLeft: '1px',
      title: 'What the open options would really settle at if closed right now: shorts bought back at the ASK, longs sold at the BID. Always worse than Open P&L, which uses the mid — the mid is a valuation convention, not a price anyone fills at. Blank when there is no two-sided quote.',
      cell: (r) => r.openExitPnL == null
        ? <span style={{ color: textMid }} title="No live bid/ask for these contracts">—</span>
        : (
          <span title={r.exitSpreadCost != null
              ? `${fmt(r.exitSpreadCost)} worse than the mid-based Open P&L — that gap is the spread you cross to get out.`
              : ''}
            style={{ fontWeight: 600, color: pnlColor(r.openExitPnL, isDark) }}>
            {fmt(r.openExitPnL)}
          </span>
        ),
      foot: (t) => <span style={{ color: pnlColor(t.openExitPnL, isDark), fontWeight: 700 }}>
        {t.openExitPnL !== 0 ? fmt(t.openExitPnL) : '—'}</span> },

    // The two halves of the day, side by side with the combined figure.
    //
    // Each is shown on its own even when the OTHER one is missing, which is
    // safe here in a way it wasn't for the total: a labelled column that reads
    // "—" is visibly absent, whereas a total silently built from one half looks
    // like a whole number and inverts the sign on a down day. That's the trap
    // the combined column now refuses; these two are what it refuses to guess.
    { key: 'dayStockPnl', label: 'Day Stock', sort: 'dayStockPnl', borderLeft: '1px',
      title: 'Today’s stock move only: shares × (price now − yesterday’s close). Blank when no daily price arrived for this name.',
      cell: (r, c) => <span style={{ fontWeight: 600, color: pnlColor(r.dayStockPnl, isDark) }}>
        {r.dayStockPnl != null ? `${r.dayStockPnl >= 0 ? '+' : ''}${fmt(r.dayStockPnl)}` : '—'}
        {r.dayStockPnl == null && c.pos > 0 && <span style={{ fontSize: 10, color: '#f59e0b' }} title="Shares held but no daily price for this name."> no px</span>}
      </span>,
      foot: (t) => <span style={{ color: pnlColor(t.dayStockPnl, isDark), fontWeight: 700 }}>
        {t.dayStockPnl >= 0 ? '+' : ''}{fmt(t.dayStockPnl)}</span> },

    { key: 'dayOptionPnl', label: 'Day Options', sort: 'dayOptionPnl', borderLeft: '1px',
      title: 'Today’s move on open option legs only, from your side of each trade — a short gains when its mark falls, a long when it rises. Blank when no leg could be priced at both ends.',
      cell: (r) => <span
        title={r.dayOptionBasis === 'market' ? 'From real prints at both ends'
             : r.dayOptionBasis === 'model' ? 'MODELLED — repriced at yesterday’s underlying, an estimate of the move rather than the move'
             : r.dayOptionBasis === 'mixed' ? 'Some legs modelled, some from real prints' : ''}
        style={{ fontWeight: 600, color: pnlColor(r.dayOptionPnl, isDark) }}>
        {r.dayOptionPnl != null ? `${r.dayOptionPnl >= 0 ? '+' : ''}${fmt(r.dayOptionPnl)}` : '—'}
        {r.dayOptionBasis === 'model' && <span style={{ fontSize: 10, color: '#f59e0b' }}> ~</span>}
      </span>,
      foot: (t) => <span style={{ color: pnlColor(t.dayOptionPnl, isDark), fontWeight: 700 }}>
        {t.dayOptionPnl >= 0 ? '+' : ''}{fmt(t.dayOptionPnl)}</span> },

    { key: 'vsStockPct', label: 'vs Stock %', borderLeft: '1px',
      title: 'How much better (or worse) options+stock did than just holding the shares, as a % of the stock result.',
      cell: (r, c) => <span title={c.vsStockPct == null ? 'No stock P&L to compare against' : `Net+Open ${fmt(c.netPlusOpen)} vs Stock ${fmt(c.stockPnl)}`}
        style={{ fontWeight: 700, color: c.vsStockPct == null ? textMid : pnlColor(c.optionsHelped ? 1 : -1, isDark) }}>
        {c.vsStockPct != null ? `${c.vsStockPct >= 0 ? '+' : ''}${c.vsStockPct.toFixed(1)}%` : '—'}</span>,
      foot: (t) => {
        const npo = t.net + t.openUnrealizedPnL
        const sp = t.stockUnrealizedPnL
        const pct = sp !== 0 ? Math.round(((npo - sp) / Math.abs(sp)) * 1000) / 10 : null
        return <span style={{ fontWeight: 700, color: pct == null ? textMid : pnlColor(npo >= sp ? 1 : -1, isDark) }}>
          {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}</span>
      } },

    { key: 'startDate', label: 'Start Date', borderLeft: '1px', align: 'center',
      cell: (r, c) => c.isEditing ? (
        <span style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
          <input type="date" value={editDraft} onChange={e => setEditDraft(e.target.value)} autoFocus
            style={{ padding: '3px 6px', borderRadius: 4, border: `1px solid ${border}`, background: surface, color: text, fontSize: 12, width: 120 }} />
          <button onClick={() => saveSymbolDate(r.ticker, editDraft)} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#22c55e', color: '#fff', fontSize: 11, cursor: 'pointer' }}>{'✓'}</button>
          <button onClick={() => setEditingSymbol(null)} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#94a3b8', color: '#fff', fontSize: 11, cursor: 'pointer' }}>{'✗'}</button>
          {c.hasOverride && <button onClick={() => { clearSymbolDate(r.ticker); setEditingSymbol(null) }} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 11, cursor: 'pointer' }}>Reset</button>}
        </span>
      ) : (
        <button onClick={() => { setEditingSymbol(r.ticker); setEditDraft(c.effectiveDate) }}
          title={c.hasOverride ? `Custom: ${c.effectiveDate}` : `Using global: ${c.effectiveDate}`}
          style={{ padding: '3px 10px', borderRadius: 4, border: `1px solid ${c.hasOverride ? '#3b82f6' : border}`,
            background: c.hasOverride ? (isDark ? '#1e3a5f' : '#eff6ff') : 'transparent',
            color: c.hasOverride ? '#3b82f6' : textMid, fontSize: 12, cursor: 'pointer', fontWeight: c.hasOverride ? 600 : 400 }}>
          {fmtDate(c.effectiveDate)}{c.hasOverride ? ' ✎' : ''}
        </button>) },

    { key: 'weeklyChangePct', label: 'Wk %', sort: 'weeklyChangePct', borderLeft: '1px',
      title: 'Stock price change over the past ~week (5 trading days)',
      cell: (r) => <span title={r.weeklyChange != null ? `${r.weeklyChange >= 0 ? '+' : ''}${fmt(r.weeklyChange)} over ~1 week` : ''}
        style={{ fontWeight: 700, color: pnlColor(r.weeklyChangePct, isDark) }}>
        {r.weeklyChangePct != null ? `${r.weeklyChangePct >= 0 ? '+' : ''}${r.weeklyChangePct.toFixed(2)}%` : '—'}</span> },
  ]

  const MOVABLE_KEYS = ALL_COLUMNS.filter(c => !c.pinned).map(c => c.key)
  // Saved order first, then any column added since — new columns append rather
  // than disappearing because they weren't in the stored list.
  const orderedKeys = (() => {
    const saved = (columnOrder || []).filter(k => MOVABLE_KEYS.includes(k))
    const missing = MOVABLE_KEYS.filter(k => !saved.includes(k))
    const out = [...saved, ...missing]

    // The what-if columns are only meaningful next to Net + Open P&L — they are
    // the same figure under a different price. Appended to a saved order they
    // land off the right edge of a table this wide, which reads as the control
    // doing nothing at all. So they're pulled back next to their reference
    // column every time rather than left wherever the append put them.
    // Only for columns the saved order has never seen. Once dragged somewhere
    // deliberately they're in `saved`, and that choice wins.
    // Each group of added columns is only meaningful beside its reference
    // column; appended to a saved order they land off the right edge of a table
    // this wide and read as though nothing happened.
    const NEIGHBOURS = [
      { keys: ['scenarioNet', 'scenarioDelta'], anchor: 'netPlusOpen' },
      { keys: ['dayStockPnl', 'dayOptionPnl'], anchor: 'dayPnl' },
      { keys: ['openExitPnL'], anchor: 'openUnrealizedPnL' },
      { keys: ['stockRealizedAll'], anchor: 'stockPnL' },
    ]
    let ordered = out
    for (const { keys, anchor: anchorKey } of NEIGHBOURS) {
      const fresh = keys.filter(k => missing.includes(k))
      if (!fresh.length) continue
      const rest = ordered.filter(k => !fresh.includes(k))
      const anchor = rest.indexOf(anchorKey)
      const at = anchor >= 0 ? anchor + 1 : rest.length
      rest.splice(at, 0, ...fresh)
      ordered = rest
    }
    return ordered
  })()
  const orderedColumns = [ALL_COLUMNS[0], ...orderedKeys.map(k => ALL_COLUMNS.find(c => c.key === k)).filter(Boolean)]

  const moveColumn = (fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey) return
    const next = orderedKeys.filter(k => k !== fromKey)
    next.splice(next.indexOf(toKey), 0, fromKey)
    saveColumnOrder(next)
  }

  // Nudge one place at a time. Dragging a table header is unusable on a touch
  // screen — the gesture is the page's scroll — so the same reordering is
  // available as buttons. Order is shared between devices, so this and the
  // desktop drag are two ways at one setting.
  const nudgeColumn = (key, delta) => {
    const i = orderedKeys.indexOf(key)
    const j = i + delta
    if (i < 0 || j < 0 || j >= orderedKeys.length) return
    const next = [...orderedKeys]
    ;[next[i], next[j]] = [next[j], next[i]]
    saveColumnOrder(next)
  }

  const resetColumnOrder = () => saveColumnOrder([])

  const cellBorder = (c) => c.borderLeft ? { borderLeft: `${c.borderLeft} solid ${border}` } : {}

  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Header controls */}
      {/* position + z-index so the toolbar's popovers stay above the table.
          .floating-panel:hover applies a transform, and a transform creates a
          stacking context — so hovering the table promoted the whole panel above
          this row and swallowed the open "hidden tickers" list. That's why it
          only misbehaved sometimes: it depended on where the cursor was. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px', flexWrap: 'wrap', position: 'relative', zIndex: 30 }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: text }}>Options YTD by Underlying</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', color: textMid, fontWeight: '500' }}>Default Start:</label>
          <input
            type="date"
            value={globalStart}
            onChange={(e) => applyGlobalStart(e.target.value)}
            style={{
              padding: '5px 8px', borderRadius: '6px', border: `1px solid ${border}`,
              background: surface, color: text, fontSize: '13px', cursor: 'pointer'
            }}
          />
          <label style={{ fontSize: '13px', color: asOf ? '#8b5cf6' : textMid, fontWeight: asOf ? 700 : 500, marginLeft: '4px' }}>As of:</label>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            title="Point-in-time view — shows your book as of this date; trades after it are ignored. Leave blank for live."
            style={{
              padding: '5px 8px', borderRadius: '6px', border: `1px solid ${asOf ? '#8b5cf6' : border}`,
              background: asOf ? (isDark ? '#2e1e47' : '#f3e8ff') : surface, color: text, fontSize: '13px', cursor: 'pointer'
            }}
          />
          {asOf && (
            <button onClick={() => setAsOf('')} title="Back to live"
              style={{ padding: '5px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: textMid, fontSize: '12px', cursor: 'pointer' }}>
              ✕ Live
            </button>
          )}
          <button
            onClick={() => { fetchData(); fetchStockHoldings() }}
            style={{
              padding: '5px 12px', borderRadius: '6px', border: 'none',
              background: '#3b82f6', color: 'white', fontSize: '12px',
              fontWeight: '600', cursor: 'pointer'
            }}
          >
            Refresh
          </button>
          {lastUpdated && (
            <span style={{ fontSize: '11px', color: textMid, whiteSpace: 'nowrap' }}
              title="Auto-refreshes every 2 minutes and when you return to the tab">
              updated {new Date(lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        {/* Row view: everything / only names with options / only held stocks */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {[
            ['all', 'All', 'Every row — names with option activity plus stocks you hold without options'],
            ['options', 'Has options', 'Only names with option activity in the selected period'],
            ['stock', 'Stock only', 'Only stocks you currently hold that have no option activity'],
          ].map(([key, label, tip]) => (
            <button
              key={key}
              onClick={() => changeRowView(key)}
              title={tip}
              style={{
                padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                borderRadius: 6,
                border: `1px solid ${rowView === key ? '#667eea' : border}`,
                background: rowView === key ? '#667eea' : 'transparent',
                color: rowView === key ? '#fff' : textMid,
              }}
            >
              {label}
              {key === 'stock' && stockOnlyCount > 0 && (
                <span style={{ marginLeft: 5, opacity: 0.75, fontWeight: 500, fontSize: 11 }}>{stockOnlyCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Row height. The table is 28 columns and the list is long, so the real
            limit is what fits on screen. Compact trades padding for rows. */}
        <button
          onClick={() => { const v = !dense; setDense(v); setPref(LS_DENSE_KEY, v) }}
          title={dense ? 'Comfortable row height' : 'Compact rows — fit more on screen'}
          style={{
            padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            borderRadius: 6,
            border: `1px solid ${dense ? '#667eea' : border}`,
            background: dense ? '#667eea' : 'transparent',
            color: dense ? '#fff' : textMid,
          }}
        >
          {dense ? '▤ Compact' : '▤ Compact'}
        </button>

        {/* What if every stock moved x% right now. The mirror of the theta
            column: that holds price and moves time, this holds time and moves
            price. Off by default so the table looks the same until asked. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: textMid, fontWeight: 600 }}
            title="Move every underlying by the same percentage and reprice. Shares reprice directly; open options are repriced with Black–Scholes at the new stock price, holding time to expiry and implied vol fixed. Realized P&L doesn't move — it's already banked.">
            What if
          </span>
          <select
            value={scenarioMove}
            onChange={e => setScenarioMove(parseFloat(e.target.value))}
            style={{
              padding: '5px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', borderRadius: 6,
              border: `1px solid ${scenarioMove !== 0 ? '#667eea' : border}`,
              background: scenarioMove !== 0 ? '#667eea' : 'transparent',
              color: scenarioMove !== 0 ? '#fff' : textMid,
            }}
          >
            <option value={0}>off</option>
            {SCENARIO_CHOICES.map(m => (
              <option key={m} value={m}>{m > 0 ? '+' : ''}{m}%</option>
            ))}
          </select>
          {scenarioMove !== 0 && (
            <span style={{ fontSize: 11, color: '#f59e0b' }}
              title="Implied vol is held where it is today (sticky strike). A real selloff usually lifts vol, which makes short options cost more to close than this shows — so the downside here is the optimistic end.">
              vol fixed ⓘ
            </span>
          )}
        </div>
        {columnOrder.length > 0 && (
          <button
            onClick={() => saveColumnOrder([])}
            title="Put the columns back in their original order for this broker tab"
            style={{
              padding: '5px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              borderRadius: 6, fontFamily: 'inherit',
              border: `1px solid ${border}`, background: 'transparent', color: textMid,
            }}
          >Reset columns</button>
        )}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search ticker…"
            style={{
              padding: '5px 26px 5px 10px', borderRadius: '6px', border: `1px solid ${border}`,
              background: surface, color: text, fontSize: '13px', width: '160px'
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} title="Clear"
              style={{ position: 'absolute', right: '6px', border: 'none', background: 'transparent',
                color: textMid, cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: 0 }}>×</button>
          )}
        </div>
        {hiddenTickers.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowHiddenList(v => !v)}
              title={`Hidden on the ${broker === 'all' ? 'All brokers' : broker} tab only. Hidden rows are excluded from the totals below.`}
              style={{ padding: '5px 10px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: textMid, fontSize: '12px', cursor: 'pointer' }}>
              🚫 {hiddenTickers.length} hidden ▾
            </button>
            {showHiddenList && (
              <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: '4px', zIndex: 200, background: surface, border: `1px solid ${border}`, borderRadius: '8px', padding: '8px', minWidth: '180px', maxWidth: '260px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' }}>
                  {hiddenTickers.map(t => (
                    <button key={t} onClick={() => restoreTicker(t)} title={`Restore ${t}`}
                      style={{ padding: '2px 7px', borderRadius: '4px', border: `1px solid ${border}`, background: isDark ? '#252d3d' : '#f1f5f9', color: text, fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>
                      {t} ✕
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: '10px', color: textMid, marginBottom: '6px', lineHeight: 1.4 }}>
                  Hidden on <strong style={{ color: text }}>{broker === 'all' ? 'All brokers' : broker}</strong> only —
                  other broker tabs are unaffected. Hidden rows are left out of the totals.
                </div>
                <button onClick={restoreAllTickers}
                  style={{ width: '100%', padding: '5px', borderRadius: '4px', border: 'none', background: '#3b82f6', color: 'white', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>
                  Show all
                </button>
              </div>
            )}
          </div>
        )}
        {/* Reorder columns without dragging. On a phone the drag gesture is the
            page's own scroll, so header dragging can't work there. Order is
            stored per user, so setting it here or by dragging on a laptop are
            two routes to the same setting. */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setShowColumnEditor(v => !v)}
            title="Reorder columns with buttons — works on touch, and the order follows your account to every device."
            style={{ padding: '5px 10px', borderRadius: '6px', border: `1px solid ${showColumnEditor ? '#667eea' : border}`,
              background: showColumnEditor ? '#667eea' : surface, color: showColumnEditor ? '#fff' : textMid,
              fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            ⇅ Columns
          </button>
          {showColumnEditor && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: '4px', zIndex: 200, background: surface,
              border: `1px solid ${border}`, borderRadius: '8px', padding: '8px', minWidth: '250px',
              maxHeight: '60vh', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
              <div style={{ fontSize: '10px', color: textMid, marginBottom: '6px', lineHeight: 1.4 }}>
                Order for <strong style={{ color: text }}>{broker === 'all' ? 'All brokers' : broker}</strong>.
                Saved to your account, so it carries to your other devices.
              </div>
              {orderedColumns.filter(c => !c.pinned).map((col, idx, arr) => (
                <div key={col.key} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 0' }}>
                  <span style={{ flex: 1, fontSize: '12px', color: text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {typeof col.label === 'string' ? col.label : col.key}
                  </span>
                  <button onClick={() => nudgeColumn(col.key, -1)} disabled={idx === 0} title="Move left"
                    style={{ padding: '3px 8px', borderRadius: '4px', border: `1px solid ${border}`, background: isDark ? '#252d3d' : '#f1f5f9',
                      color: idx === 0 ? textMid : text, fontSize: '12px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.4 : 1 }}>↑</button>
                  <button onClick={() => nudgeColumn(col.key, 1)} disabled={idx === arr.length - 1} title="Move right"
                    style={{ padding: '3px 8px', borderRadius: '4px', border: `1px solid ${border}`, background: isDark ? '#252d3d' : '#f1f5f9',
                      color: idx === arr.length - 1 ? textMid : text, fontSize: '12px', cursor: idx === arr.length - 1 ? 'default' : 'pointer', opacity: idx === arr.length - 1 ? 0.4 : 1 }}>↓</button>
                </div>
              ))}
              <button onClick={resetColumnOrder}
                style={{ width: '100%', marginTop: '6px', padding: '5px', borderRadius: '4px', border: 'none', background: '#94a3b8', color: 'white', fontSize: '11px', fontWeight: '600', cursor: 'pointer' }}>
                Reset to default
              </button>
            </div>
          )}
        </div>
        <span style={{ fontSize: '12px', color: textMid }}>
          Click a date cell to set a per-symbol start date · hover a row to hide it · reorder columns by dragging a header or with ⇅ Columns (saved to your account)
        </span>
        {stockDebug && (
          <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
            background: stockDebug.holdings?.length > 0 ? '#22c55e22' : '#f59e0b22',
            color: stockDebug.holdings?.length > 0 ? '#22c55e' : '#f59e0b' }}>
            Stock: {stockDebug.holdings?.length > 0
              ? `${stockDebug.holdings.length} holdings loaded`
              : `0 holdings — ${JSON.stringify(stockDebug.debug || stockDebug.error || 'no data').slice(0,120)}`}
          </span>
        )}
      </div>

      {asOf && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', background: isDark ? '#2e1e47' : '#f3e8ff', border: `1px solid ${isDark ? '#5b3a8a' : '#d8b4fe'}`, color: isDark ? '#e2e8f0' : '#6b21a8', marginBottom: '12px', fontSize: '13px' }}>
          🕒 <strong>As of {fmtDate(asOf)}</strong> — trades after this date are excluded. Realized P&L, open premium, and stock positions/values reflect that day (stock priced at its close). <em>Open P&L is a Black–Scholes estimate</em> (marked “~”; no historical option quotes exist), and Day P&L / Wk% are blank for past dates.
        </div>
      )}

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', background: '#fee2e2', color: '#991b1b', marginBottom: '12px', fontSize: '13px' }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '24px', color: textMid, fontSize: '14px' }}>Loading…</div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div style={{ textAlign: 'center', padding: '32px', color: textMid, fontSize: '14px' }}>
          No options data found from {fmtDate(globalStart)}. Upload a CSV to get started.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="floating-panel" style={{ overflowX: 'auto', position: 'relative', borderRadius: '10px', border: `1px solid ${border}` }}>
          <table className="ytd-panel-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: '13px', background: surface }}>
            <colgroup>
              <col style={{ width: '44px' }} />
            </colgroup>
            <thead>
              <tr style={{ background: headerBg, borderBottom: `2px solid ${border}` }}>
                {orderedColumns.map(col => {
                  const pinned = !!col.pinned
                  const base = col.sort ? thStyle(col.sort) : { ...thStyle(null), cursor: 'default' }
                  const isDragTarget = dragOverKey === col.key && dragKey && dragKey !== col.key
                  return (
                    <th
                      key={col.key}
                      draggable={!pinned}
                      onDragStart={e => { if (pinned) return; setDragKey(col.key); e.dataTransfer.effectAllowed = 'move' }}
                      onDragOver={e => { if (pinned || !dragKey) return; e.preventDefault(); if (dragOverKey !== col.key) setDragOverKey(col.key) }}
                      onDrop={e => { if (pinned) return; e.preventDefault(); moveColumn(dragKey, col.key); setDragKey(null); setDragOverKey(null) }}
                      onDragEnd={() => { setDragKey(null); setDragOverKey(null) }}
                      onClick={col.sort ? () => toggleSort(col.sort) : undefined}
                      title={col.title || (pinned ? undefined : 'Drag to reorder')}
                      style={{
                        ...base,
                        ...(col.align === 'left' ? { textAlign: 'left', padding: '10px 4px' } : {}),
                        ...(col.align === 'center' ? { textAlign: 'center' } : {}),
                        ...cellBorder(col),
                        ...(pinned
                          ? {
                              position: 'sticky', left: 0, top: 0, zIndex: 4,
                              background: sortField === 'ticker' ? (isDark ? '#1a2035' : '#f0f4ff') : (isDark ? '#151929' : '#f8fafc'),
                              boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}`,
                            }
                          : { cursor: dragKey ? 'grabbing' : 'grab' }),
                        ...(isDragTarget ? { boxShadow: 'inset 3px 0 0 var(--accent)' } : {}),
                        ...(dragKey === col.key ? { opacity: 0.4 } : {}),
                      }}
                    >
                      {col.header ? col.header() : col.label}
                      {col.sort && <SortIcon field={col.sort} />}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const c = rowCtx(row, i)
                return (
                  <React.Fragment key={row.ticker}>
                  <tr
                    style={{ borderBottom: `1px solid ${border}`, background: c.tickerBg }}
                    onMouseEnter={e => { e.currentTarget.style.background = rowHover }}
                    onMouseLeave={e => { e.currentTarget.style.background = c.tickerBg }}
                  >
                    {orderedColumns.map(col => col.pinned ? (
                      <td key={col.key} style={{
                        padding: padPin, fontWeight: 700, color: text, letterSpacing: '0.03em',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        position: 'sticky', left: 0, zIndex: 1, background: c.tickerBg,
                        boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}`,
                      }}>
                        {row.hasOptions && (
                          <button onClick={e => { e.stopPropagation(); toggleRowDetail(row.ticker) }}
                            title={`Show the individual option contracts behind ${row.ticker}`}
                            style={{ marginRight: 4, padding: '0 4px', fontSize: 11, lineHeight: 1.3,
                              border: `1px solid ${border}`, borderRadius: 3, cursor: 'pointer',
                              background: openRow === row.ticker ? '#3b82f6' : 'transparent',
                              color: openRow === row.ticker ? '#fff' : textMid }}>
                            {openRow === row.ticker ? '−' : '+'}
                          </button>
                        )}
                        {row.ticker}
                        {!row.hasOptions && (
                          <span title="Stock only — no option activity in this period."
                            style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                              padding: '1px 4px', borderRadius: 3, verticalAlign: 'middle',
                              color: textMid, border: `1px solid ${border}` }}>STK</span>
                        )}
                        <button className="ytd-hide" onClick={e => { e.stopPropagation(); hideTicker(row.ticker) }}
                          title={`Hide ${row.ticker} from view`}
                          style={{ position: 'absolute', top: '50%', right: 1, transform: 'translateY(-50%)',
                            width: 15, height: 15, padding: 0, lineHeight: '13px', textAlign: 'center',
                            border: 'none', borderRadius: '50%', cursor: 'pointer', fontSize: 12,
                            fontWeight: 700, color: '#fff', background: '#ef4444' }}>{'×'}</button>
                      </td>
                    ) : (
                      <td key={col.key} style={{ padding: padCell, textAlign: col.align || 'right', ...cellBorder(col) }}>
                        {col.cell ? col.cell(row, c) : null}
                      </td>
                    ))}
                  </tr>

                  {openRow === row.ticker && (
                    <tr style={{ background: isDark ? '#141a2b' : '#f7f9fc' }}>
                      <td colSpan={orderedColumns.length} style={{ padding: '10px 16px', borderBottom: `1px solid ${border}` }}>
                        {rowDetail.loading && <span style={{ fontSize: 12, color: textMid }}>Pricing contracts…</span>}
                        {rowDetail.error && <span style={{ fontSize: 12, color: '#ef4444' }}>{rowDetail.error}</span>}
                        {rowDetail.data && <OpenContractsDetail d={rowDetail.data} isDark={isDark} fmt={fmt} pnlColor={pnlColor} />}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${border}`, background: headerBg }}>
                {orderedColumns.map(col => col.pinned ? (
                  <td key={col.key} style={{
                    padding: padPin, fontWeight: 700, color: text, fontSize: 11,
                    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    // Totals stay visible while scanning, so a row can be judged
                    // against the portfolio without scrolling to the bottom.
                    position: 'sticky', left: 0, bottom: 0, zIndex: 4,
                    background: isDark ? '#151929' : '#f8fafc',
                    boxShadow: `2px 0 4px ${isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)'}`,
                  }}>
                    Total ({sorted.length})
                  </td>
                ) : (
                  <td key={col.key} style={{ padding: padCell, textAlign: col.align || 'right', position: 'sticky', bottom: 0, zIndex: 1, background: headerBg, ...cellBorder(col) }}>
                    {col.foot ? col.foot(totals) : null}
                  </td>
                ))}
              </tr>
            </tfoot>

          </table>
        </div>
      )}

      {/* Portalled to document.body so it can't be trapped under the sticky
          ticker column's stacking context. Positioned from the clicked cell's
          rect in viewport coordinates, which is why it's fixed rather than
          absolute. */}
      {histFor && histAnchor && createPortal(
        <PriceHistoryPopover
          state={hist}
          ticker={histFor}
          anchor={histAnchor}
          nowPrice={histNow.price}
          nowValue={histNow.value}
          onClose={() => { setHistFor(null); setHistAnchor(null) }}
          isDark={isDark} fmt={fmt} pnlColor={pnlColor}
        />,
        document.body
      )}
    </div>
  )
}

/**
 * Previous visits to roughly the current price.
 *
 * Each row is compared against today, because the useful number isn't what the
 * position was worth then — it's whether it's worth more now at the same stock
 * price. That difference is the premium collected and decayed since, with the
 * share move held constant by construction.
 */
function PriceHistoryPopover({ state, ticker, anchor, nowPrice, nowValue, onClose, isDark, fmt, pnlColor }) {
  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2a3142' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1e293b'
  const textMid = isDark ? '#94a3b8' : '#64748b'

  // A fixed popover doesn't move with the row it belongs to, so on scroll it
  // would sit over an unrelated one. Closing is honest; tracking the row would
  // be nicer but needs the anchor recomputed every frame.
  useEffect(() => {
    const close = () => onClose()
    const onKey = (ev) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        // Fixed, in viewport coordinates, because this is portalled to body and
        // has no positioned ancestor. Clamped so a row near the right edge or
        // the bottom of the window doesn't push it off screen.
        position: 'fixed',
        top: Math.min(anchor.top + 6, window.innerHeight - 240),
        right: Math.max(8, anchor.right),
        zIndex: 9999,
        background: surface, border: `1px solid ${border}`, borderRadius: 8,
        padding: '10px 12px', minWidth: 290, textAlign: 'left',
        boxShadow: '0 6px 20px rgba(0,0,0,0.18)', fontWeight: 400,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: text }}>
          {ticker} near {fmt(nowPrice)} · Net + Open
        </span>
        <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: textMid, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
      </div>

      {state.loading && <div style={{ fontSize: 12, color: textMid }}>Looking…</div>}
      {state.error && <div style={{ fontSize: 12, color: '#ef4444' }}>{state.error}</div>}

      {!state.loading && !state.error && state.visits.length === 0 && (
        <div style={{ fontSize: 12, color: textMid, lineHeight: 1.5 }}>
          {ticker} hasn't traded near {fmt(nowPrice)} in the last two years, other than
          the past few days.
        </div>
      )}

      {state.visits.map(v => {
        const delta = (nowValue != null && v.netPlusOpen != null) ? nowValue - v.netPlusOpen : null
        return (
          <div key={v.date} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 12.5, borderTop: `1px solid ${border}` }}>
            <span style={{ color: textMid, whiteSpace: 'nowrap' }}
              title={v.netPlusOpen != null
                ? `Net ${fmt(v.net)} + open options ${v.openPnl != null ? fmt(v.openPnl) : '—'}`
                  + (v.shares != null ? ` · ${v.shares} shares` : '')
                : 'No as-of figure for this date'}>
              {v.date} · {fmt(v.price)}
            </span>
            <span style={{ display: 'flex', gap: 8, whiteSpace: 'nowrap', alignItems: 'baseline' }}>
              <span style={{ color: pnlColor(v.netPlusOpen, isDark), fontWeight: 600 }}>
                {v.netPlusOpen != null ? fmt(v.netPlusOpen) : '—'}
              </span>
              {delta != null && (
                <span style={{ color: pnlColor(delta, isDark), fontWeight: 700 }}>
                  {delta >= 0 ? '+' : ''}{fmt(delta)}
                </span>
              )}
            </span>
          </div>
        )
      })}

      {state.visits.length > 0 && (
        <div style={{ fontSize: 10.5, color: textMid, marginTop: 6, lineHeight: 1.45, borderTop: `1px solid ${border}`, paddingTop: 6 }}>
          Each figure comes from the same <strong>as-of</strong> view you can open for that
          date, so the two always agree. Its open-option leg is a Black-Scholes estimate at
          that day's underlying — there are no historical option quotes to price it exactly.
          {state.band > 2 && ` Widened to ±${state.band}% to find these.`}
        </div>
      )}
    </div>
  )
}

/**
 * The individual option contracts behind one ticker's row.
 *
 * Shows where each mark came from, because that's the difference between a
 * measured number and an estimated one — and on a thinly traded contract it's
 * the difference between agreeing with the broker and not.
 */
function OpenContractsDetail({ d, isDark, fmt, pnlColor }) {
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const text = isDark ? '#e2e8f0' : '#1e293b'
  const border = isDark ? '#2a3142' : '#e2e8f0'

  const live = (d.rows || []).filter(r => !r.skipped)
  if (live.length === 0) {
    return <span style={{ fontSize: 12, color: textMid }}>No open option contracts for {d.ticker}.</span>
  }

  const label = {
    quote: ['market', '#22c55e'],
    today: ['traded today', '#22c55e'],
    agedClose: ['aged', '#f59e0b'],
    model: ['modelled', '#f59e0b'],
    staleClose: ['stale print', '#ef4444'],
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: textMid, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
        {d.ticker} — {live.length} open contract{live.length === 1 ? '' : 's'}
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          {live.map((r, i) => {
            const [txt, colour] = label[r.basis] || ['—', textMid]
            return (
              <tr key={i}>
                <td style={{ padding: '3px 14px 3px 0', color: text, whiteSpace: 'nowrap' }}>{r.symbol}</td>
                <td style={{ padding: '3px 14px 3px 0', fontWeight: 600, whiteSpace: 'nowrap',
                             color: r.side === 'long' ? '#22c55e' : '#f59e0b' }}>
                  {r.side === 'long' ? 'LONG' : 'SHORT'} {r.contracts}
                </td>
                <td style={{ padding: '3px 14px 3px 0', color: textMid, whiteSpace: 'nowrap' }}>
                  mark {r.mark != null ? fmt(r.mark) : '—'}
                </td>
                <td style={{ padding: '3px 14px 3px 0', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: 10.5, color: colour }}>{txt}</span>
                  {r.volume != null && (
                    <span style={{ fontSize: 10.5, color: textMid }}> · vol {r.volume}</span>
                  )}
                </td>
                <td style={{ padding: '3px 0', fontWeight: 700, whiteSpace: 'nowrap',
                             color: pnlColor(r.openPnl, isDark) }}>
                  {r.openPnl != null ? fmt(r.openPnl) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: textMid, marginTop: 8, lineHeight: 1.5 }}>
        Total {fmt(d.totalOpenPnl)}.
        {' '}A <strong>stale print</strong> is the last trade in a contract that hasn't traded
        recently — on a thin contract that can sit a long way from where it would trade now,
        which is the usual reason a figure disagrees with your broker.
      </div>
    </div>
  )
}

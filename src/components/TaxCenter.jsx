import React, { useState, useMemo } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import {
  buildTaxSummary,
  buildSummaryFromPnl,
  estimateTax,
  relevantForms,
  availableTaxYears
} from '../utils/taxCalculator'

const LS_PLAN = 'taxCenter_plan'

const fmt = (n) => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `-$${abs}` : `$${abs}`
}
const fmtDate = (d) => {
  if (!d) return '—'
  const dt = d instanceof Date ? d : new Date(d)
  if (isNaN(dt)) return '—'
  return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
}

export default function TaxCenter({ trades = [], dividendsAndInterest = [], pnlData = [], currentPrices = {}, accountName = '' }) {
  const { isDark } = useTheme()

  const surface = isDark ? '#1e2130' : '#ffffff'
  const border = isDark ? '#2d3748' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1a202c'
  const textMid = isDark ? '#94a3b8' : '#64748b'
  const headerBg = isDark ? '#151929' : '#f8fafc'
  const gain = (n) => (n == null || n === 0 ? textMid : n > 0 ? '#22c55e' : '#ef4444')

  const years = useMemo(() => {
    const y = availableTaxYears(trades, dividendsAndInterest)
    return y.length ? y : [new Date().getFullYear()]
  }, [trades, dividendsAndInterest])

  const [year, setYear] = useState(() => years[0])
  // Keep selected year valid when data changes
  const activeYear = years.includes(year) ? year : years[0]

  const [plan, setPlan] = useState(() => {
    try {
      return {
        ordinaryRate: 24,
        longTermRate: 15,
        dividendsQualified: true,
        extraWithholding: 0,
        ...JSON.parse(localStorage.getItem(LS_PLAN) || '{}')
      }
    } catch {
      return { ordinaryRate: 24, longTermRate: 15, dividendsQualified: true, extraWithholding: 0 }
    }
  })
  const savePlan = (next) => {
    setPlan(next)
    localStorage.setItem(LS_PLAN, JSON.stringify(next))
  }

  const hasTrades = trades.length > 0
  const summary = useMemo(
    () =>
      hasTrades
        ? buildTaxSummary(trades, dividendsAndInterest, activeYear)
        : buildSummaryFromPnl(pnlData, dividendsAndInterest, activeYear),
    [hasTrades, trades, dividendsAndInterest, pnlData, activeYear]
  )
  const fromPositions = summary.source === 'positions'

  const totalWithholding = (summary.withholding || 0) + (parseFloat(plan.extraWithholding) || 0)

  const tax = useMemo(
    () =>
      estimateTax({
        shortTermGain: summary.shortTermGain,
        longTermGain: summary.longTermGain,
        dividends: summary.dividends,
        interest: summary.interest,
        ordinaryRate: parseFloat(plan.ordinaryRate) || 0,
        longTermRate: parseFloat(plan.longTermRate) || 0,
        dividendsQualified: plan.dividendsQualified,
        withholding: totalWithholding
      }),
    [summary, plan, totalWithholding]
  )

  const forms = useMemo(() => relevantForms(summary), [summary])

  // Price lookup for open positions (for unrealized + loss harvesting)
  const priceOf = (symbol) => {
    if (currentPrices && currentPrices[symbol] > 0) return currentPrices[symbol]
    const p = pnlData.find((x) => x.symbol === symbol && !x.isOption)
    return p?.currentPrice > 0 ? p.currentPrice : 0
  }

  const openWithMarket = summary.openLots.map((o) => {
    const price = o.currentPrice > 0 ? o.currentPrice : priceOf(o.symbol)
    const marketValue = price > 0 ? price * o.quantity : null
    const unrealized =
      marketValue != null ? marketValue - o.costBasis : (o.unrealizedFromData != null ? o.unrealizedFromData : null)
    const daysToLongTerm = o.earliestHoldingDays != null ? Math.max(366 - o.earliestHoldingDays, 0) : null
    return { ...o, price, marketValue, unrealized, daysToLongTerm }
  })

  const harvestCandidates = openWithMarket
    .filter((o) => o.unrealized != null && o.unrealized < 0)
    .sort((a, b) => a.unrealized - b.unrealized)

  const nearLongTerm = openWithMarket
    .filter((o) => o.daysToLongTerm > 0 && o.daysToLongTerm <= 60 && o.unrealized != null && o.unrealized > 0)
    .sort((a, b) => a.daysToLongTerm - b.daysToLongTerm)

  const noData = trades.length === 0 && pnlData.length === 0

  // ---- 1099-B / Form 8949 worksheet generation (client-side, on the fly) ----
  const mdy = (d) => {
    if (!d) return ''
    const dt = d instanceof Date ? d : new Date(d)
    if (isNaN(dt)) return ''
    return `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`
  }
  const num = (n) => (n == null || isNaN(n) ? '0.00' : Number(n).toFixed(2))

  const stRows = summary.allRealized.filter((r) => r.term === 'short')
  const ltRows = summary.allRealized.filter((r) => r.term === 'long')
  const totals = (rows) => rows.reduce(
    (a, r) => ({
      proceeds: a.proceeds + (r.proceeds || 0),
      cost: a.cost + (r.costBasis || 0),
      wash: a.wash + (r.washSale ? Math.abs(r.gain || 0) : 0),
      gain: a.gain + (r.gain || 0)
    }),
    { proceeds: 0, cost: 0, wash: 0, gain: 0 }
  )

  const triggerDownload = (blob, filename) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const download1099Bcsv = () => {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`
    const headers = [
      'Description of property (Box 1a)',
      'Date acquired (Box 1b)',
      'Date sold or disposed (Box 1c)',
      'Proceeds (Box 1d)',
      'Cost or other basis (Box 1e)',
      'Wash sale loss disallowed (Box 1g)',
      'Code (Box 1f)',
      'Gain or (loss)',
      'Term'
    ]
    const lines = [headers.map(esc).join(',')]
    for (const r of summary.allRealized) {
      lines.push([
        `${r.quantity} ${r.symbol}`,
        mdy(r.buyDate),
        mdy(r.sellDate),
        num(r.proceeds),
        num(r.costBasis),
        r.washSale ? num(Math.abs(r.gain)) : '',
        r.washSale ? 'W' : '',
        num(r.gain),
        r.term === 'long' ? 'Long-term' : 'Short-term'
      ].map(esc).join(','))
    }
    const t = totals(summary.allRealized)
    lines.push('')
    lines.push(['TOTALS', '', '', num(t.proceeds), num(t.cost), num(t.wash), '', num(t.gain), ''].map(esc).join(','))
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    triggerDownload(blob, `1099B-worksheet-${activeYear}.csv`)
  }

  const printConsolidated1099 = () => {
    const stT = totals(stRows)
    const ltT = totals(ltRows)
    const allT = totals(summary.allRealized)
    const ordinaryDiv = summary.dividends
    const qualifiedDiv = plan.dividendsQualified ? summary.dividends : 0

    const recipient = accountName ? String(accountName).replace(/</g, '&lt;') : 'Account holder'
    const chk = (on, txt) => `<span class="chk">${on ? '☒' : '☐'}${txt ? ' ' + txt : ''}</span>`
    const money = (v) => `$ ${num(v)}`
    const officialForm = (o) => `
      <div class="formwrap">
        <table class="f"><colgroup><col style="width:40%"><col style="width:44%"><col style="width:16%"></colgroup><tbody>
          <tr>
            <td style="padding:0">
              <table class="inner"><tbody>
                <tr><td style="height:74px"><span class="lbl">PAYER'S name, street address, city or town, state, ZIP, and telephone no.</span><br><span class="b">Self-generated from Robinhood account activity</span><br><span class="lbl">Unofficial — not issued by a broker; not filed with the IRS</span></td></tr>
                <tr><td style="padding:0"><table class="inner nb"><tbody><tr><td style="width:50%"><span class="lbl">PAYER'S TIN</span><br>&mdash;</td><td><span class="lbl">RECIPIENT'S TIN</span><br>&mdash;</td></tr></tbody></table></td></tr>
                <tr><td style="height:28px"><span class="lbl">RECIPIENT'S name</span><br><span class="b">${o.recipient}</span></td></tr>
                <tr><td style="height:24px"><span class="lbl">Street address (including apt. no.)</span></td></tr>
                <tr><td style="height:24px"><span class="lbl">City or town, state/province, country, ZIP</span></td></tr>
                <tr><td><span class="lbl">Account number (see instructions)</span><br>UNOFFICIAL-${o.termCode}</td></tr>
                <tr><td style="padding:0"><table class="inner nb"><tbody><tr><td style="width:33%"><span class="lbl">14 State</span></td><td style="width:34%"><span class="lbl">15 State no.</span></td><td><span class="lbl">16 State tax withheld</span><br>$ 0.00</td></tr></tbody></table></td></tr>
              </tbody></table>
            </td>
            <td style="padding:0">
              <table class="inner"><tbody>
                <tr><td style="width:50%"><span class="lbl">Applicable checkbox on Form 8949</span><br><span class="b">${o.box8949}</span></td><td><span class="lbl">OMB No. 1545-0715</span><br><span class="big">${o.yearLabel}</span><br><span class="b">Form 1099-B</span></td></tr>
                <tr><td colspan="2"><span class="lbl">1a Description of property</span><br><span class="b">${o.desc}</span></td></tr>
                <tr><td><span class="lbl">1b Date acquired</span><br>${o.acquired}</td><td><span class="lbl">1c Date sold or disposed</span><br>${o.sold}</td></tr>
                <tr><td><span class="lbl">1d Proceeds</span><br><span class="val">${money(o.proceeds)}</span></td><td><span class="lbl">1e Cost or other basis</span><br><span class="val">${money(o.cost)}</span></td></tr>
                <tr><td><span class="lbl">1f Accrued market discount</span><br>$ 0.00</td><td><span class="lbl">1g Wash sale loss disallowed</span><br><span class="val">${money(o.wash)}</span></td></tr>
                <tr><td><span class="lbl">2 Type of gain or loss</span><br>${chk(o.isShort, 'Short-term')} ${chk(o.isLong, 'Long-term')} ${chk(false, 'Ordinary')}</td><td><span class="lbl">3 Proceeds from</span><br>${chk(false, 'Collectibles')} ${chk(false, 'QOF')}</td></tr>
                <tr><td><span class="lbl">4 Federal income tax withheld</span><br><span class="val">${money(o.withheld)}</span></td><td><span class="lbl">5 Noncovered security</span><br>${chk(true, '')}</td></tr>
                <tr><td><span class="lbl">6 Reported to IRS</span><br>${chk(true, 'Gross proceeds')} ${chk(false, 'Net')}</td><td><span class="lbl">7 Loss not allowed per 1d</span><br>${chk(false, '')}</td></tr>
                <tr><td><span class="lbl">8 Profit/(loss) closed contracts</span><br>$ 0.00</td><td><span class="lbl">9 Unrealized open—prior yr</span><br>$ 0.00</td></tr>
                <tr><td><span class="lbl">10 Unrealized open—current yr</span><br>$ 0.00</td><td><span class="lbl">11 Aggregate profit/(loss)</span><br><span class="val ${o.gain < 0 ? 'neg' : 'pos'}">${money(o.gain)}</span></td></tr>
                <tr><td><span class="lbl">12 Basis reported to IRS</span><br>${chk(false, '')}</td><td><span class="lbl">13 Bartering</span><br>$ 0.00</td></tr>
              </tbody></table>
            </td>
            <td style="padding:5px;font-size:9px;text-align:center">
              <div class="b" style="font-size:11px;margin-bottom:8px">Proceeds From Broker and Barter Exchange Transactions</div>
              <div class="b">Copy B<br>For Recipient</div>
              <div style="margin-top:10px;color:#b91c1c;font-weight:bold">UNOFFICIAL</div>
            </td>
          </tr>
        </tbody></table>
        <div class="lbl" style="margin-top:2px">Form 1099-B &middot; www.irs.gov/Form1099B &middot; Unofficial reproduction — informational only</div>
      </div>`
    const formsHtml =
      (stRows.length ? officialForm({ yearLabel: activeYear, recipient, termCode: 'ST', box8949: 'B — Short-term, basis not reported', desc: `Aggregate of ${stRows.length} short-term transactions (see detail below)`, acquired: 'Various', sold: 'Various', isShort: true, isLong: false, proceeds: stT.proceeds, cost: stT.cost, wash: stT.wash, gain: stT.gain, withheld: 0 }) : '') +
      (ltRows.length ? officialForm({ yearLabel: activeYear, recipient, termCode: 'LT', box8949: 'E — Long-term, basis not reported', desc: `Aggregate of ${ltRows.length} long-term transactions (see detail below)`, acquired: 'Various', sold: 'Various', isShort: false, isLong: true, proceeds: ltT.proceeds, cost: ltT.cost, wash: ltT.wash, gain: ltT.gain, withheld: 0 }) : '')

    const detail = (title, rows) => {
      if (rows.length === 0) return ''
      const t = totals(rows)
      const body = rows.map((r) => `
        <tr>
          <td>${r.quantity} ${String(r.symbol).replace(/</g, '&lt;')}</td>
          <td class="c">${mdy(r.buyDate)}</td>
          <td class="c">${mdy(r.sellDate)}</td>
          <td class="r">${num(r.proceeds)}</td>
          <td class="r">${num(r.costBasis)}</td>
          <td class="r">${r.washSale ? num(Math.abs(r.gain)) : ''}</td>
          <td class="c">${r.washSale ? 'W' : ''}</td>
          <td class="r ${r.gain < 0 ? 'neg' : 'pos'}">${num(r.gain)}</td>
        </tr>`).join('')
      return `
        <h3>${title} &mdash; ${rows.length} transactions</h3>
        <table>
          <thead><tr>
            <th>Description (1a)</th><th>Acquired (1b)</th><th>Sold (1c)</th>
            <th class="r">Proceeds (1d)</th><th class="r">Cost basis (1e)</th><th class="r">Wash sale (1g)</th>
            <th class="c">Code (1f)</th><th class="r">Gain/(loss)</th>
          </tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr>
            <td colspan="3">Totals</td>
            <td class="r">${num(t.proceeds)}</td>
            <td class="r">${num(t.cost)}</td>
            <td class="r">${num(t.wash)}</td>
            <td></td>
            <td class="r ${t.gain < 0 ? 'neg' : 'pos'}">${num(t.gain)}</td>
          </tr></tfoot>
        </table>`
    }

    const payerRecipientCell = (code) => `
      <td style="padding:0">
        <table class="inner"><tbody>
          <tr><td style="height:70px"><span class="lbl">PAYER'S name, street address, city or town, state, ZIP, and telephone no.</span><br><span class="b">Self-generated from Robinhood account activity</span><br><span class="lbl">Unofficial — not issued by a broker; not filed with the IRS</span></td></tr>
          <tr><td style="padding:0"><table class="inner nb"><tbody><tr><td style="width:50%"><span class="lbl">PAYER'S TIN</span><br>&mdash;</td><td><span class="lbl">RECIPIENT'S TIN</span><br>&mdash;</td></tr></tbody></table></td></tr>
          <tr><td style="height:26px"><span class="lbl">RECIPIENT'S name</span><br><span class="b">${recipient}</span></td></tr>
          <tr><td style="height:24px"><span class="lbl">Street address (including apt. no.)</span></td></tr>
          <tr><td style="height:24px"><span class="lbl">City or town, state/province, country, ZIP</span></td></tr>
          <tr><td><span class="lbl">Account number (see instructions)</span><br>UNOFFICIAL-${code}</td></tr>
        </tbody></table>
      </td>`

    const divForm = () => `
      <div class="formwrap">
        <table class="f"><colgroup><col style="width:40%"><col style="width:44%"><col style="width:16%"></colgroup><tbody><tr>
          ${payerRecipientCell('DIV')}
          <td style="padding:0"><table class="inner"><tbody>
            <tr><td style="width:50%"><span class="lbl">1a Total ordinary dividends</span><br><span class="val">${money(ordinaryDiv)}</span></td><td><span class="lbl">OMB No. 1545-0110</span><br><span class="b">Form 1099-DIV</span><br><span class="lbl">For calendar year ${activeYear}</span></td></tr>
            <tr><td><span class="lbl">1b Qualified dividends</span><br><span class="val">${money(qualifiedDiv)}</span></td><td><span class="lbl">2a Total capital gain distr.</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">2b Unrecap. Sec. 1250 gain</span><br>$ 0.00</td><td><span class="lbl">2c Section 1202 gain</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">2d Collectibles (28%) gain</span><br>$ 0.00</td><td><span class="lbl">2e Section 897 ordinary dividends</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">2f Section 897 capital gain</span><br>$ 0.00</td><td><span class="lbl">3 Nondividend distributions</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">4 Federal income tax withheld</span><br>$ 0.00</td><td><span class="lbl">5 Section 199A dividends</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">6 Investment expenses</span><br>$ 0.00</td><td><span class="lbl">7 Foreign tax paid</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">8 Foreign country or U.S. possession</span><br>&mdash;</td><td><span class="lbl">9 Cash liquidation distributions</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">10 Noncash liquidation distributions</span><br>$ 0.00</td><td><span class="lbl">11 FATCA filing requirement</span><br>${chk(false, '')}</td></tr>
            <tr><td><span class="lbl">12 Exempt-interest dividends</span><br>$ 0.00</td><td><span class="lbl">13 Specified private activity bond int. div.</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">14 State</span><br>&mdash;</td><td><span class="lbl">15 State ID no. &nbsp;·&nbsp; 16 State tax withheld</span><br>$ 0.00</td></tr>
          </tbody></table></td>
          <td style="padding:5px;font-size:9px;text-align:center">
            <div class="b" style="font-size:12px;margin-bottom:8px">Dividends and Distributions</div>
            <div class="b">Copy B<br>For Recipient</div>
            <div style="margin-top:10px;color:#b91c1c;font-weight:bold">UNOFFICIAL</div>
          </td>
        </tr></tbody></table>
        <div class="lbl" style="margin-top:2px">Form 1099-DIV &middot; www.irs.gov/Form1099DIV &middot; Unofficial reproduction — informational only</div>
      </div>`

    const intForm = () => `
      <div class="formwrap">
        <table class="f"><colgroup><col style="width:40%"><col style="width:44%"><col style="width:16%"></colgroup><tbody><tr>
          ${payerRecipientCell('INT')}
          <td style="padding:0"><table class="inner"><tbody>
            <tr><td style="width:50%"><span class="lbl">1 Interest income</span><br><span class="val">${money(summary.interest)}</span></td><td><span class="lbl">OMB No. 1545-0112</span><br><span class="b">Form 1099-INT</span><br><span class="lbl">For calendar year ${activeYear}</span></td></tr>
            <tr><td><span class="lbl">2 Early withdrawal penalty</span><br>$ 0.00</td><td><span class="lbl">3 Interest on U.S. Savings Bonds &amp; Treas. obligations</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">4 Federal income tax withheld</span><br>$ 0.00</td><td><span class="lbl">5 Investment expenses</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">6 Foreign tax paid</span><br>$ 0.00</td><td><span class="lbl">7 Foreign country or U.S. possession</span><br>&mdash;</td></tr>
            <tr><td><span class="lbl">8 Tax-exempt interest</span><br>$ 0.00</td><td><span class="lbl">9 Specified private activity bond interest</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">10 Market discount</span><br>$ 0.00</td><td><span class="lbl">11 Bond premium</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">12 Bond premium on Treasury obligations</span><br>$ 0.00</td><td><span class="lbl">13 Bond premium on tax-exempt bond</span><br>$ 0.00</td></tr>
            <tr><td><span class="lbl">14 Tax-exempt &amp; tax credit bond CUSIP no.</span><br>&mdash;</td><td><span class="lbl">15 State &nbsp;·&nbsp; 16 State ID &nbsp;·&nbsp; 17 State tax withheld</span><br>$ 0.00</td></tr>
          </tbody></table></td>
          <td style="padding:5px;font-size:9px;text-align:center">
            <div class="b" style="font-size:12px;margin-bottom:8px">Interest Income</div>
            <div class="b">Copy B<br>For Recipient</div>
            <div style="margin-top:10px;color:#b91c1c;font-weight:bold">UNOFFICIAL</div>
          </td>
        </tr></tbody></table>
        <div class="lbl" style="margin-top:2px">Form 1099-INT &middot; www.irs.gov/Form1099INT &middot; Unofficial reproduction — informational only</div>
      </div>`

    const divBlock = summary.dividends > 0 ? `<h2>Form 1099-DIV — Dividends and Distributions</h2>${divForm()}` : ''
    const intBlock = summary.interest > 0 ? `<h2>Form 1099-INT — Interest Income</h2>${intForm()}` : ''

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${activeYear} Consolidated Form 1099 (Unofficial)</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:26px;font-size:12px;position:relative}
        .wm{position:fixed;top:42%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:96px;color:#000;opacity:0.06;font-weight:800;letter-spacing:6px;pointer-events:none;z-index:0}
        .content{position:relative;z-index:1}
        h1{font-size:20px;margin:0 0 2px}
        h2{font-size:15px;margin:22px 0 6px;border-bottom:2px solid #334155;padding-bottom:3px}
        h3{font-size:13px;margin:14px 0 6px}
        .sub{color:#555;font-size:11px;margin-bottom:10px}
        .meta{display:flex;justify-content:space-between;gap:20px;font-size:11px;margin:8px 0 14px}
        .meta div{border:1px solid #cbd5e1;border-radius:6px;padding:8px 10px;flex:1}
        .stamp{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:8px 12px;border-radius:6px;font-size:11px;margin:10px 0;font-weight:600}
        .disc{background:#fffbeb;border:1px solid #fde68a;padding:8px 10px;border-radius:6px;font-size:10.5px;color:#6b5b23;margin:8px 0}
        table{width:100%;border-collapse:collapse;margin-bottom:8px}
        th,td{border:1px solid #cbd5e1;padding:5px 7px;font-size:11px}
        th{background:#f1f5f9;text-align:left}
        td.r,th.r{text-align:right}.c{text-align:center}
        tfoot td{font-weight:bold;background:#f8fafc}
        .neg{color:#b91c1c}.pos{color:#065f46}
        .formwrap{margin:0 0 18px;page-break-inside:avoid}
        table.f{width:100%;border-collapse:collapse;border:2px solid #000;table-layout:fixed;margin:0}
        table.f>tbody>tr>td{border:1px solid #000;vertical-align:top}
        table.inner{width:100%;height:100%;border-collapse:collapse;margin:0}
        table.inner td{border:1px solid #000;vertical-align:top;padding:3px 5px}
        table.inner.nb, table.inner.nb td{border:none}
        .lbl{font-size:8.5px;color:#111}
        .b{font-weight:bold}
        .val{font-size:11px;font-weight:bold}
        .big{font-size:20px;font-weight:bold;letter-spacing:1px}
        .chk{font-size:10px;white-space:nowrap}
        @media print{.noprint{display:none}}
      </style></head><body>
      <div class="wm">UNOFFICIAL</div>
      <div class="content">
      <h1>${activeYear} Consolidated Form 1099</h1>
      <div class="sub">Substitute statement combining 1099-B, 1099-DIV and 1099-INT &middot; Generated ${new Date().toLocaleDateString('en-US')}</div>
      <div class="stamp">⚠️ UNOFFICIAL COPY — informational reconstruction from account activity. This was NOT issued by a broker and was NOT filed with the IRS. Only your broker's official Consolidated 1099 is valid for tax filing.</div>
      <h2>Form 1099-B — Proceeds From Broker and Barter Exchange Transactions</h2>
      ${formsHtml}

      ${divBlock}
      ${intBlock}

      <h2>Form 1099-B — Transaction Detail (Form 8949)</h2>
      ${detail('Part I — Short-Term (held one year or less)', stRows)}
      ${detail('Part II — Long-Term (held more than one year)', ltRows)}

      <div class="disc"><strong>Notes:</strong> Cost basis computed FIFO. Wash sales (code “W”) are estimated on a same-ticker, ±30-day basis and may differ from your broker's determination across accounts and substantially-identical securities. Dividend qualified/ordinary split reflects your Tax Center toggle, not issuer classification. Verify every figure against your broker's official Consolidated 1099 before filing. Not tax advice.</div>
      <button class="noprint" onclick="window.print()" style="margin:10px 0;padding:8px 16px;cursor:pointer;font-size:13px">🖨️ Print / Save as PDF</button>
      </div>
      </body></html>`
    const w = window.open('', '_blank')
    if (!w) {
      alert('Please allow pop-ups to open the Consolidated 1099 document.')
      return
    }
    w.document.write(html)
    w.document.close()
    w.focus()
  }

  const has1099B = summary.allRealized.length > 0

  // ---- shared styles ----
  const card = (accent) => ({
    background: surface,
    border: `1px solid ${border}`,
    borderTop: `3px solid ${accent}`,
    borderRadius: '10px',
    padding: '14px 16px',
    minWidth: '150px',
    flex: '1 1 150px'
  })
  const sectionTitle = { fontSize: '16px', fontWeight: 700, color: text, margin: '0 0 12px 0' }
  const th = { padding: '9px 12px', textAlign: 'right', fontSize: '11px', fontWeight: 600, color: textMid, textTransform: 'uppercase', letterSpacing: '0.04em', background: headerBg, borderBottom: `2px solid ${border}`, whiteSpace: 'nowrap' }
  const thLeft = { ...th, textAlign: 'left' }
  const td = { padding: '8px 12px', textAlign: 'right', fontSize: '13px', color: text, borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap' }
  const tdLeft = { ...td, textAlign: 'left', fontWeight: 600 }
  // Estimate-table cells: allow labels to wrap so the summary never overflows its card
  const etd = { padding: '8px 12px', textAlign: 'right', fontSize: '13px', color: text, borderBottom: `1px solid ${border}`, whiteSpace: 'normal' }
  const etdLeft = { ...etd, textAlign: 'left', fontWeight: 600 }
  const label = { fontSize: '12px', color: textMid, fontWeight: 500 }
  const input = { padding: '6px 8px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px', width: '90px' }
  const box = { background: surface, border: `1px solid ${border}`, borderRadius: '12px', padding: '18px', marginBottom: '20px' }

  return (
    <div style={{ padding: '8px 0', maxWidth: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <h1 style={{ margin: 0, fontSize: '22px', color: text }}>🧾 Tax Center</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={label}>Tax year</span>
          <select
            value={activeYear}
            onChange={(e) => setYear(parseInt(e.target.value))}
            style={{ ...input, width: 'auto', cursor: 'pointer' }}
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ fontSize: '12px', color: textMid, background: isDark ? '#1a2035' : '#fffbeb', border: `1px solid ${isDark ? '#2d3748' : '#fde68a'}`, borderRadius: '8px', padding: '10px 14px', marginBottom: '18px' }}>
        ⚠️ Estimates for planning only — not tax advice. Your broker's official 1099 is the filing source of record.
        Figures use FIFO cost basis and simplified wash-sale / qualified-dividend rules. Consult a tax professional.
      </div>

      {noData && (
        <div style={{ textAlign: 'center', padding: '40px', color: textMid, fontSize: '14px' }}>
          No trade data loaded yet. Upload a Robinhood CSV to populate your tax figures.
        </div>
      )}

      {!noData && (
        <>
          {fromPositions && (
            <div style={{ fontSize: '12px', color: textMid, background: isDark ? '#152033' : '#eff6ff', border: `1px solid ${isDark ? '#1e3a5f' : '#bfdbfe'}`, borderRadius: '8px', padding: '10px 14px', marginBottom: '18px' }}>
              📊 Using aggregated data from your Positions/Dashboard. This gives realized totals, cost basis, dividends and the forms checklist. The short-term vs long-term split, per-lot detail, and wash-sale detection need your full trade-history CSV — click <strong>Upload CSV</strong> above to unlock them.
            </div>
          )}

          {/* Summary cards */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '22px' }}>
            {fromPositions ? (
              <div style={card('#3b82f6')}>
                <div style={label}>Realized Gain</div>
                <div style={{ fontSize: '20px', fontWeight: 700, color: gain(summary.totalRealizedGain), marginTop: '4px' }}>{fmt(summary.totalRealizedGain)}</div>
                <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>term split needs full CSV</div>
              </div>
            ) : (
              <>
                <div style={card('#3b82f6')}>
                  <div style={label}>Short-Term Realized</div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: gain(summary.shortTermGain), marginTop: '4px' }}>{fmt(summary.shortTermGain)}</div>
                  <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>{summary.shortTermCount} lots · taxed as ordinary income</div>
                </div>
                <div style={card('#8b5cf6')}>
                  <div style={label}>Long-Term Realized</div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: gain(summary.longTermGain), marginTop: '4px' }}>{fmt(summary.longTermGain)}</div>
                  <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>{summary.longTermCount} lots · preferential rate</div>
                </div>
              </>
            )}
            {!fromPositions && (
              <div style={card('#0ea5e9')}>
                <div style={label}>Total Realized Gain</div>
                <div style={{ fontSize: '20px', fontWeight: 700, color: gain(summary.totalRealizedGain), marginTop: '4px' }}>{fmt(summary.totalRealizedGain)}</div>
                <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>Proceeds {fmt(summary.totalProceeds)}</div>
              </div>
            )}
            <div style={card('#22c55e')}>
              <div style={label}>Dividends</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: text, marginTop: '4px' }}>{fmt(summary.dividends)}</div>
              <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>1099-DIV income</div>
            </div>
            <div style={card('#14b8a6')}>
              <div style={label}>Interest</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: text, marginTop: '4px' }}>{fmt(summary.interest)}</div>
              <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>1099-INT income</div>
            </div>
            <div style={card(tax.balance > 0 ? '#ef4444' : '#22c55e')}>
              <div style={label}>{tax.balance > 0 ? 'Est. Tax Owed' : 'Est. Refund'}</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: tax.balance > 0 ? '#ef4444' : '#22c55e', marginTop: '4px' }}>{fmt(Math.abs(tax.balance))}</div>
              <div style={{ fontSize: '11px', color: textMid, marginTop: '2px' }}>after {fmt(totalWithholding)} withheld</div>
            </div>
          </div>

          {/* Tax planning + estimate */}
          <div style={box}>
            <h2 style={sectionTitle}>📐 Tax Planning &amp; Estimate</h2>
            {fromPositions && (
              <div style={{ fontSize: '12px', color: textMid, marginBottom: '12px' }}>
                Without purchase dates, all realized gains are treated as short-term (ordinary rate) here — a conservative estimate. Upload your CSV to split long-term gains at the lower rate.
              </div>
            )}
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                  <span style={label}>Ordinary income rate (short-term, interest)</span>
                  <div><input type="number" value={plan.ordinaryRate} onChange={(e) => savePlan({ ...plan, ordinaryRate: e.target.value })} style={{ ...input, width: '64px' }} />%</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                  <span style={label}>Long-term capital gains rate</span>
                  <div><input type="number" value={plan.longTermRate} onChange={(e) => savePlan({ ...plan, longTermRate: e.target.value })} style={{ ...input, width: '64px' }} />%</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                  <span style={label}>Extra withholding (W-2, quarterly est.)</span>
                  <div>$<input type="number" value={plan.extraWithholding} onChange={(e) => savePlan({ ...plan, extraWithholding: e.target.value })} style={{ ...input, width: '90px' }} /></div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', ...label, cursor: 'pointer' }}>
                  <input type="checkbox" checked={plan.dividendsQualified} onChange={(e) => savePlan({ ...plan, dividendsQualified: e.target.checked })} />
                  Treat dividends as qualified (long-term rate)
                </label>
              </div>

              <div style={{ flex: '1 1 320px', minWidth: 0, overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: '300px', borderCollapse: 'collapse', fontSize: '13px', tableLayout: 'fixed' }}>
                  <colgroup>
                    <col />
                    <col style={{ width: '120px' }} />
                  </colgroup>
                  <tbody>
                    <EstRow label="Net short-term gain/loss" value={fmt(tax.netShort)} color={gain(tax.netShort)} {...{ td: etd, tdLeft: etdLeft }} />
                    <EstRow label="Net long-term gain/loss" value={fmt(tax.netLong)} color={gain(tax.netLong)} {...{ td: etd, tdLeft: etdLeft }} />
                    <EstRow label="Net capital gain/loss" value={fmt(tax.netCapital)} color={gain(tax.netCapital)} {...{ td: etd, tdLeft: etdLeft }} />
                    {tax.capitalLossOffset > 0 && (
                      <EstRow label="Loss applied vs ordinary income (max $3k)" value={`-${fmt(tax.capitalLossOffset)}`} color={textMid} {...{ td: etd, tdLeft: etdLeft }} />
                    )}
                    {tax.capitalLossCarryover > 0 && (
                      <EstRow label="Capital loss carried to next year" value={fmt(tax.capitalLossCarryover)} color={textMid} {...{ td: etd, tdLeft: etdLeft }} />
                    )}
                    <EstRow label={`Ordinary-rate tax (${plan.ordinaryRate}%)`} value={fmt(tax.ordinaryTax)} color={text} {...{ td: etd, tdLeft: etdLeft }} />
                    <EstRow label={`Preferential-rate tax (${plan.longTermRate}%)`} value={fmt(tax.preferentialTax)} color={text} {...{ td: etd, tdLeft: etdLeft }} />
                    <tr>
                      <td style={{ ...etdLeft, fontWeight: 700, borderTop: `2px solid ${border}` }}>Estimated tax liability</td>
                      <td style={{ ...etd, fontWeight: 700, fontSize: '15px', borderTop: `2px solid ${border}` }}>{fmt(tax.estimatedTax)}</td>
                    </tr>
                    <tr>
                      <td style={etdLeft}>Total withheld</td>
                      <td style={etd}>{fmt(totalWithholding)}</td>
                    </tr>
                    <tr>
                      <td style={{ ...etdLeft, fontWeight: 700 }}>{tax.balance > 0 ? 'Estimated balance due' : 'Estimated refund'}</td>
                      <td style={{ ...etd, fontWeight: 700, fontSize: '15px', color: tax.balance > 0 ? '#ef4444' : '#22c55e' }}>{fmt(Math.abs(tax.balance))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Planning insights */}
          {(harvestCandidates.length > 0 || nearLongTerm.length > 0 || summary.washSales.length > 0) && (
            <div style={box}>
              <h2 style={sectionTitle}>💡 Planning Insights</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {harvestCandidates.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, color: text, marginBottom: '4px' }}>🍂 Tax-loss harvesting candidates</div>
                    <div style={{ fontSize: '12px', color: textMid, marginBottom: '6px' }}>
                      Open positions currently at an unrealized loss. Selling realizes the loss to offset gains (mind the 30-day wash-sale rule before rebuying).
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {harvestCandidates.slice(0, 12).map((o) => (
                        <span key={o.symbol} style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '6px', background: isDark ? '#3f1d1d' : '#fef2f2', color: '#ef4444', fontWeight: 600 }}>
                          {o.symbol} {fmt(o.unrealized)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {nearLongTerm.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, color: text, marginBottom: '4px' }}>⏳ Approaching long-term treatment</div>
                    <div style={{ fontSize: '12px', color: textMid, marginBottom: '6px' }}>
                      Profitable positions close to the 1-year mark. Holding past it taxes gains at the lower long-term rate.
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {nearLongTerm.slice(0, 12).map((o) => (
                        <span key={o.symbol} style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '6px', background: isDark ? '#1e3a2f' : '#f0fdf4', color: '#22c55e', fontWeight: 600 }}>
                          {o.symbol} · {o.daysToLongTerm}d left
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {summary.washSales.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, color: text, marginBottom: '4px' }}>🚫 Possible wash sales ({summary.washSales.length})</div>
                    <div style={{ fontSize: '12px', color: textMid, marginBottom: '6px' }}>
                      Losses realized where the same ticker was bought within 30 days — the IRS may disallow ~{fmt(summary.washSaleDisallowed)} of these losses. Verify against your 1099-B.
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {[...new Set(summary.washSales.map((w) => w.symbol))].slice(0, 12).map((s) => (
                        <span key={s} style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '6px', background: isDark ? '#3a2f1a' : '#fffbeb', color: '#f59e0b', fontWeight: 600 }}>{s}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Cost basis of open positions */}
          <div style={box}>
            <h2 style={sectionTitle}>📦 Cost Basis — Open Positions ({openWithMarket.length})</h2>
            <div style={{ fontSize: '12px', color: textMid, marginBottom: '10px' }}>Total open cost basis: <strong style={{ color: text }}>{fmt(summary.openCostBasis)}</strong> (FIFO)</div>
            {openWithMarket.length === 0 ? (
              <div style={{ color: textMid, fontSize: '13px' }}>No open stock positions.</div>
            ) : (
              <div style={{ overflowX: 'auto', border: `1px solid ${border}`, borderRadius: '10px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: surface }}>
                  <thead>
                    <tr>
                      <th style={thLeft}>Symbol</th>
                      <th style={th}>Shares</th>
                      <th style={th}>Avg Cost</th>
                      <th style={th}>Cost Basis</th>
                      <th style={th}>Price</th>
                      <th style={th}>Market Value</th>
                      <th style={th}>Unrealized</th>
                      <th style={th}>Held Since</th>
                      <th style={th}>Term Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openWithMarket.map((o) => (
                      <tr key={o.symbol}>
                        <td style={tdLeft}>{o.symbol}</td>
                        <td style={td}>{o.quantity.toLocaleString()}</td>
                        <td style={td}>{fmt(o.avgCost)}</td>
                        <td style={td}>{fmt(o.costBasis)}</td>
                        <td style={td}>{o.price > 0 ? fmt(o.price) : '—'}</td>
                        <td style={td}>{o.marketValue != null ? fmt(o.marketValue) : '—'}</td>
                        <td style={{ ...td, color: gain(o.unrealized), fontWeight: 600 }}>{o.unrealized != null ? fmt(o.unrealized) : '—'}</td>
                        <td style={td}>{fmtDate(o.earliestDate)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {o.daysToLongTerm == null ? (
                            <span style={{ color: textMid }}>—</span>
                          ) : o.daysToLongTerm > 0 ? (
                            <span style={{ color: '#3b82f6' }}>{o.daysToLongTerm}d to long-term</span>
                          ) : (
                            <span style={{ color: '#8b5cf6' }}>Long-term ✓</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Realized gains detail */}
          <div style={box}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <h2 style={{ ...sectionTitle, marginBottom: 0 }}>📄 Realized Gains Detail — {activeYear} ({summary.allRealized.length})</h2>
              {has1099B && (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={printConsolidated1099} style={{ padding: '7px 14px', borderRadius: '6px', border: 'none', background: '#667eea', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }} title="Open an unofficial Consolidated 1099 (1099-B + DIV + INT) you can save as PDF">
                    🧾 Consolidated 1099 (PDF)
                  </button>
                  <button onClick={download1099Bcsv} style={{ padding: '7px 14px', borderRadius: '6px', border: `1px solid ${border}`, background: surface, color: text, fontSize: '13px', fontWeight: 600, cursor: 'pointer' }} title="Download a 1099-B / 8949 worksheet as CSV for tax software">
                    ⬇️ 1099-B (CSV)
                  </button>
                </div>
              )}
            </div>
            <div style={{ fontSize: '12px', color: textMid, margin: '8px 0 10px' }}>These are the lot-level lines that make up your Form 8949 / Schedule D. The 1099-B buttons generate an informational worksheet (not an official IRS 1099-B) from this data.</div>
            {summary.allRealized.length === 0 ? (
              <div style={{ color: textMid, fontSize: '13px' }}>
                {fromPositions
                  ? `Per-lot detail isn't available from Positions data. Upload your full trade-history CSV to see every 8949/Schedule D line.`
                  : `No closed positions in ${activeYear}.`}
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: '420px', overflowY: 'auto', border: `1px solid ${border}`, borderRadius: '10px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: surface }}>
                  <thead>
                    <tr>
                      <th style={{ ...thLeft, position: 'sticky', top: 0 }}>Symbol</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Qty</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Acquired</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Sold</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Proceeds</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Cost Basis</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Gain/Loss</th>
                      <th style={{ ...th, position: 'sticky', top: 0 }}>Term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.allRealized.map((r, i) => (
                      <tr key={i}>
                        <td style={{ ...tdLeft, maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.symbol}>
                          {r.type === 'option' ? '⚙️ ' : ''}{r.symbol}
                        </td>
                        <td style={td}>{r.quantity}</td>
                        <td style={td}>{fmtDate(r.buyDate)}</td>
                        <td style={td}>{fmtDate(r.sellDate)}</td>
                        <td style={td}>{fmt(r.proceeds)}</td>
                        <td style={td}>{fmt(r.costBasis)}</td>
                        <td style={{ ...td, color: gain(r.gain), fontWeight: 600 }}>
                          {fmt(r.gain)}{r.washSale ? ' 🚫' : ''}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px', background: r.term === 'long' ? (isDark ? '#2e1e47' : '#f3e8ff') : (isDark ? '#1e2f47' : '#eff6ff'), color: r.term === 'long' ? '#8b5cf6' : '#3b82f6' }}>
                            {r.term === 'long' ? 'Long' : 'Short'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ ...tdLeft, fontWeight: 700, background: headerBg }} colSpan={4}>Total</td>
                      <td style={{ ...td, fontWeight: 700, background: headerBg }}>{fmt(summary.totalProceeds)}</td>
                      <td style={{ ...td, fontWeight: 700, background: headerBg }}>{fmt(summary.totalCostBasis)}</td>
                      <td style={{ ...td, fontWeight: 700, color: gain(summary.totalRealizedGain), background: headerBg }}>{fmt(summary.totalRealizedGain)}</td>
                      <td style={{ ...td, background: headerBg }}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Withholding */}
          <div style={box}>
            <h2 style={sectionTitle}>💵 YTD Withholding</h2>
            <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap', fontSize: '13px' }}>
              <div>
                <div style={label}>Detected in CSV</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: text }}>{fmt(summary.withholding)}</div>
                <div style={{ fontSize: '11px', color: textMid }}>backup / foreign tax entries</div>
              </div>
              <div>
                <div style={label}>Manually entered</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: text }}>{fmt(parseFloat(plan.extraWithholding) || 0)}</div>
                <div style={{ fontSize: '11px', color: textMid }}>edit in Planning above</div>
              </div>
              <div>
                <div style={label}>Total withheld</div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: '#3b82f6' }}>{fmt(totalWithholding)}</div>
                <div style={{ fontSize: '11px', color: textMid }}>applied to the estimate</div>
              </div>
            </div>
            {summary.withholding === 0 && (
              <div style={{ fontSize: '12px', color: textMid, marginTop: '10px' }}>
                No withholding found in the CSV (Robinhood brokerage accounts usually have none unless backup withholding applies). Add W-2 or quarterly estimated payments in the Planning section for a full picture.
              </div>
            )}
          </div>

          {/* Tax forms checklist */}
          <div style={box}>
            <h2 style={sectionTitle}>🗂️ Tax Forms for This Account</h2>
            <div style={{ fontSize: '12px', color: textMid, marginBottom: '12px' }}>
              Your broker issues 1099-series forms; you file the 8949/Schedule D/B. Status reflects what your loaded activity suggests.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
              {forms.map((f) => {
                const c = f.status === 'likely' ? '#22c55e' : f.status === 'possible' ? '#f59e0b' : '#94a3b8'
                const badgeBg = f.status === 'likely' ? (isDark ? '#1e3a2f' : '#f0fdf4') : f.status === 'possible' ? (isDark ? '#3a2f1a' : '#fffbeb') : (isDark ? '#252d3d' : '#f1f5f9')
                const badgeText = f.status === 'likely' ? 'Likely applies' : f.status === 'possible' ? 'If applicable' : 'Not indicated'
                return (
                  <div key={f.form} style={{ border: `1px solid ${border}`, borderLeft: `3px solid ${c}`, borderRadius: '8px', padding: '12px 14px', background: surface }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 700, color: text, fontSize: '14px' }}>{f.form}</span>
                      <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', background: badgeBg, color: c, whiteSpace: 'nowrap' }}>{badgeText}</span>
                    </div>
                    <div style={{ fontSize: '12px', fontWeight: 600, color: textMid, marginBottom: '4px' }}>{f.title}</div>
                    <div style={{ fontSize: '12px', color: textMid, lineHeight: 1.45 }}>{f.desc}</div>
                    <div style={{ fontSize: '11px', color: textMid, marginTop: '6px', fontStyle: 'italic' }}>Applies when: {f.condition}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function EstRow({ label, value, color, td, tdLeft }) {
  return (
    <tr>
      <td style={tdLeft}>{label}</td>
      <td style={{ ...td, color }}>{value}</td>
    </tr>
  )
}

/**
 * Fill in and sign a PDF, entirely in the browser.
 *
 * pdf.js draws each page to a canvas so there is something to click on, and an
 * absolutely-positioned layer over it holds whatever gets placed. Nothing in
 * that layer touches the document until Save, at which point pdf-lib reopens
 * the ORIGINAL bytes and writes the marks onto it. Editing a rendering and
 * editing a document are different things, and keeping the original untouched
 * until the end is what stops a save from compounding the last one.
 *
 * Coordinates are stored as fractions of the page, never pixels: zoom changes
 * the canvas, and a mark placed at 40% across belongs at 40% across whatever
 * size it is being drawn or written at.
 */
import * as pdfjsLib from '/pdf/vendor/pdfjs/pdf.min.mjs'
import {
  PDFDocument, StandardFonts, rgb, degrees,
  // Imported as classes, not compared by name: the build we serve is minified,
  // so `constructor.name` is a mangled letter and every `=== 'PDFCheckBox'`
  // silently failed -- which sent checkboxes through getTextField() and made
  // saving die with "Expected instance of n".
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFButton,
} from '/pdf/vendor/pdf-lib/pdf-lib.esm.min.js'

/** One stable name per field type, safe across minified builds. */
function fieldKind(f) {
  if (f instanceof PDFCheckBox) return 'check'
  if (f instanceof PDFDropdown) return 'dropdown'
  if (f instanceof PDFRadioGroup) return 'radio'
  if (f instanceof PDFButton) return 'button'
  if (f instanceof PDFTextField) return 'text'
  return 'other'
}

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf/vendor/pdfjs/pdf.worker.min.mjs'

// Bumped whenever this file changes, and shown in the toolbar. "Still broken"
// and "still running yesterday's code" look identical otherwise.
const BUILD = 'b22'

const $ = (id) => document.getElementById(id)
const state = {
  bytes: null,        // the original file, kept pristine for saving
  doc: null,          // pdf.js document, for rendering
  name: 'document.pdf',
  zoom: 1.15,
  marks: [],          // { id, page, type, xf, yf, wf, hf, text, sizeF, dataUrl }
  fields: [],         // AcroForm fields found by pdf-lib
  tool: null,         // 'text' | 'sign' | 'white' | 'check'
  signature: null,    // data URL, reused between placements
  selected: null,
  editing: null,      // the text mark with the caret in it, edited on the page
  seq: 0,
}

/* ── chrome ──────────────────────────────────────────────────────────── */

function toast(msg, ms = 2600) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.hidden = true }, ms)
}

function setTool(tool) {
  state.tool = state.tool === tool ? null : tool
  for (const [id, name] of [['toolText', 'text'], ['toolSign', 'sign'], ['toolWhite', 'white'], ['toolCheck', 'check']]) {
    $(id).classList.toggle('on', state.tool === name)
  }
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('placing', !!state.tool))
}

/* ── opening ─────────────────────────────────────────────────────────── */

async function openFile(file) {
  if (!file) return
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    return toast('That is not a PDF')
  }
  // An empty file is not a document, and opening one used to leave the app in a
  // half-started state holding zero bytes it would happily save back out.
  if (!file.size) {
    return toast(`"${file.name}" is empty — 0 bytes, nothing to open. `
      + 'If this app emptied it, run pdfEditorDebug() in the console to find it.', 11000)
  }
  state.bytes = new Uint8Array(await file.arrayBuffer())
  state.name = file.name || 'document.pdf'
  state.marks = []
  state.selected = null
  state.saveHandle = null          // a new document saves to a new file

  // Was this file made by this app? Then reopen what it was made FROM, with the
  // boxes still editable, rather than the flattened result -- see rememberSave().
  const made = await recall(state.name, state.bytes.length)
  if (made) {
    state.bytes = made.source
    state.marks = Array.isArray(made.marks) ? made.marks : []
    state.seq = made.seq || state.marks.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0)
  }
  const restored = made ? state.marks.length : restoreMarks()
  $('docName').textContent = state.name
  $('empty').hidden = true
  $('save').disabled = false
  $('saveAs').disabled = false

  // pdf.js is handed a COPY: it transfers the buffer it is given, which would
  // leave the original detached and empty by the time Save needed it.
  // Many official forms are "encrypted" with an empty owner password: they open
  // anywhere, but every library refuses them until told to carry on. The DS-11
  // passport form is one, which is exactly the kind of thing this app is for.
  try {
    state.doc = await pdfjsLib.getDocument({ data: state.bytes.slice(), password: '' }).promise
  } catch (e) {
    // Leave nothing loaded, so Save cannot write a document that never opened.
    state.bytes = null
    state.doc = null
    $('save').disabled = true
    $('saveAs').disabled = true
    $('docName').textContent = 'no file open'
    return toast(`Could not open "${state.name}": ${e.message}`, 10000)
  }
  // A restored box belonging to a page this document does not have would be
  // invisible and unreachable, so it is dropped rather than carried along.
  state.marks = state.marks.filter(m => m.page >= 1 && m.page <= state.doc.numPages)
  await renderAll()
  await readFormFields()
  renderItems()
  const pages = `${state.doc.numPages} page${state.doc.numPages === 1 ? '' : 's'} open`
  toast(restored && state.marks.length
    ? `${pages} — ${state.marks.length} box${state.marks.length === 1 ? '' : 'es'} restored from last time, still editable`
    : pages, restored ? 5000 : 2600)
}

async function renderAll() {
  const host = $('pages')
  host.textContent = ''
  for (let n = 1; n <= state.doc.numPages; n++) {
    const page = await state.doc.getPage(n)
    const viewport = page.getViewport({ scale: state.zoom })
    const wrap = document.createElement('div')
    wrap.className = 'page' + (state.tool ? ' placing' : '')
    wrap.style.width = `${Math.floor(viewport.width)}px`
    wrap.style.height = `${Math.floor(viewport.height)}px`
    wrap.dataset.page = String(n)

    const canvas = document.createElement('canvas')
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    const ctx = canvas.getContext('2d')
    ctx.scale(ratio, ratio)
    wrap.appendChild(canvas)

    const layer = document.createElement('div')
    layer.className = 'layer'
    layer.addEventListener('pointerdown', (e) => onLayerDown(e, n, layer))
    wrap.appendChild(layer)

    host.appendChild(wrap)
    await page.render({ canvasContext: ctx, viewport }).promise
  }
  drawMarks()
  $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`
}

/** AcroForm fields, when the PDF has real ones. Most "forms" do not. */
async function readFormFields() {
  const box = $('fields')
  box.textContent = ''
  state.fields = []
  state.xfa = false
  try {
    const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true })

    // XFA: the fields you see are drawn by a form engine Acrobat ships and
    // pdf-lib does not implement. It strips that data on save, so the file
    // still opens and still looks right, while the thing the recipient's
    // system reads is gone. Better to say so now than to have a bank reject it.
    try {
      const acro = doc.catalog.get(doc.context.obj('AcroForm'))
      const resolved = acro && doc.context.lookup(acro)
      if (resolved && resolved.get && resolved.get(doc.context.obj('XFA'))) state.xfa = true
    } catch { /* not XFA, or not readable -- treat as ordinary */ }

    const form = doc.getForm()
    const fields = form.getFields()
    if (state.xfa) {
      const warn = document.createElement('p')
      warn.className = 'pad small'
      warn.style.color = '#b45309'
      warn.innerHTML = '<strong>This is an XFA form.</strong> Its fields are filled by Acrobat\'s form engine, which this app cannot write. '
        + 'Typing on the page with <strong>Add text</strong> and signing works and prints correctly — but saving will drop the XFA data, '
        + 'so send it as a printed/flattened document rather than as a fillable form.'
      box.appendChild(warn)
    }
    if (!fields.length) {
      box.innerHTML = '<p class="muted pad small">No form fields in this PDF — use <strong>Add text</strong> to type anywhere on the page.</p>'
      $('fieldsTitle').textContent = 'Form fields'
      return
    }
    $('fieldsTitle').textContent = `Form fields (${fields.length})`
    for (const f of fields) {
      const name = f.getName()
      const kind = fieldKind(f)
      // Push buttons hold no value; listing them just buries the fields that do.
      if (kind === 'button') continue
      const row = document.createElement('div')
      row.className = 'field'
      const label = document.createElement('label')
      label.textContent = name
      row.appendChild(label)

      if (kind === 'check') {
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = (() => { try { return f.isChecked() } catch { return false } })()
        cb.addEventListener('change', () => { state.fields.find(x => x.name === name).value = cb.checked })
        row.appendChild(cb)
        state.fields.push({ name, kind, value: cb.checked })
      } else if (kind === 'dropdown' || kind === 'radio') {
        const sel = document.createElement('select')
        sel.className = 'input wide'
        const opts = (() => { try { return f.getOptions() } catch { return [] } })()
        sel.appendChild(new Option('—', ''))
        opts.forEach(o => sel.appendChild(new Option(o, o)))
        sel.addEventListener('change', () => { state.fields.find(x => x.name === name).value = sel.value })
        row.appendChild(sel)
        state.fields.push({ name, kind, value: '' })
      } else {
        const inp = document.createElement('input')
        inp.className = 'input wide'
        inp.value = (() => { try { return f.getText() || '' } catch { return '' } })()
        inp.addEventListener('input', () => { state.fields.find(x => x.name === name).value = inp.value })
        row.appendChild(inp)
        state.fields.push({ name, kind, value: inp.value })
      }
      box.appendChild(row)
    }
  } catch (e) {
    // An unreadable form is not a dead document: the page still renders, so
    // text and a signature can still go on it.
    box.innerHTML = `<p class="muted pad small">No usable form fields (${e.message.slice(0, 90)}). `
      + 'Use <strong>Add text</strong> to type on the page instead.</p>'
  }
}

/* ── placing and moving marks ────────────────────────────────────────── */

function onLayerDown(e, pageNo, layer) {
  if (!state.tool) return
  if (e.target !== layer) return          // clicking an existing mark selects it
  const r = layer.getBoundingClientRect()
  const xf = (e.clientX - r.left) / r.width
  const yf = (e.clientY - r.top) / r.height

  if (state.tool === 'sign') {
    if (!state.signature) { openSignature(pageNo, xf, yf); return }
    addMark({ type: 'image', page: pageNo, xf, yf, wf: 0.22, hf: 0.07, dataUrl: state.signature })
  } else if (state.tool === 'white') {
    addMark({ type: 'white', page: pageNo, xf, yf, wf: 0.16, hf: 0.022 })
  } else if (state.tool === 'check') {
    addMark({ type: 'text', page: pageNo, xf, yf, text: '✓', sizeF: 0.018 })
  } else {
    // Placed with the caret already in it and the placeholder selected, so the
    // first keystroke replaces it. A prompt() asked for the words before
    // showing where they would land; a sidebar box asked you to type somewhere
    // other than where the text is.
    const m = { type: 'text', page: pageNo, xf, yf, text: 'Text', sizeF: 0.014 }
    m.id = ++state.seq
    state.marks.push(m)
    state.editing = m.id
    drawMarks()
    select(m.id)
  }
  setTool(null)
}

function addMark(m) {
  m.id = ++state.seq
  state.marks.push(m)
  // Selected on arrival: whatever was just placed is what someone wants to
  // adjust, and it saves hunting for it in the list.
  drawMarks()
  select(m.id)
}

/* ── remembering boxes between sessions ──────────────────────────────── */

/**
 * Saving writes the marks INTO the pdf, where they stop being boxes and become
 * page content -- so a reopened document has nothing left to click. The boxes
 * are therefore kept here as well, in this browser, against the file they were
 * placed on.
 *
 * The key includes the byte length, which quietly prevents the nastiest case:
 * save over a file and its length changes, so the old boxes no longer match it
 * and cannot be drawn a second time on top of the copy that already has them.
 * Keep the original untouched and save to a separate file, and reopening the
 * original brings the boxes back exactly as they were.
 */
const storeKey = () => `pdfedit:${state.name}:${state.bytes.length}`

function persist() {
  clearTimeout(persist._t)
  persist._t = setTimeout(() => {
    if (!state.bytes) return
    try {
      const key = storeKey()
      if (!state.marks.length) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify({ seq: state.seq, marks: state.marks, at: Date.now() }))
    } catch (e) {
      // A full or disabled store is not worth interrupting anyone over.
      console.warn('could not remember the boxes:', e.message)
    }
  }, 400)
}

/* ── reopening what this app saved ───────────────────────────────────── */

/**
 * Remembering the boxes against the ORIGINAL file only helps if you reopen the
 * original. Nobody does that: you reopen the file you just saved -- and that
 * one has the boxes baked into it, with nothing left to click.
 *
 * So each save also records what the saved file was MADE from: the source bytes
 * and the boxes. Reopen that saved file and the app quietly puts the source back
 * with the boxes still boxes, so editing carries on where it left off and the
 * next save regenerates the file rather than drawing on top of itself.
 *
 * The bytes live in IndexedDB (localStorage is far too small) in this browser
 * only. A handful of recent documents is kept; older ones are dropped.
 */
const DB_NAME = 'pdf-editor', DB_STORE = 'documents', DB_KEEP = 8
const madeKey = (name, size) => `${name}:${size}`

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function dbDo(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode)
    const result = fn(tx.objectStore(DB_STORE))
    tx.oncomplete = () => { db.close(); resolve(result && result.result) }
    tx.onerror = () => { db.close(); reject(tx.error) }
  }))
}

/** A small index of what is stored, so eviction never loads the bytes. */
function madeIndex(next) {
  const KEY = 'pdfedit:made-index'
  let idx = {}
  try { idx = JSON.parse(localStorage.getItem(KEY) || '{}') } catch {}
  if (!next) return idx
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {}
  return next
}

async function rememberSave(savedName, savedSize) {
  try {
    const key = madeKey(savedName, savedSize)
    await dbDo('readwrite', s => s.put({
      source: state.bytes, sourceName: state.name,
      marks: state.marks, seq: state.seq, at: Date.now(),
    }, key))
    console.info(`[pdf-editor] remembered "${key}" — source ${state.name} (${state.bytes.length} bytes), ${state.marks.length} boxes`)

    const idx = { ...madeIndex(), [key]: Date.now() }
    const stale = Object.entries(idx).sort((a, b) => b[1] - a[1]).slice(DB_KEEP)
    for (const [old] of stale) {
      delete idx[old]
      await dbDo('readwrite', s => s.delete(old)).catch(() => {})
    }
    madeIndex(idx)
  } catch (e) {
    // Not being able to remember is not a reason to fail a save.
    console.warn('could not remember what this file was made from:', e.message)
  }
}

async function recall(name, size) {
  try {
    const key = madeKey(name, size)
    const rec = await dbDo('readonly', s => s.get(key))
    console.info(`[pdf-editor] opened "${key}" — ${rec ? `FOUND, ${rec.marks?.length ?? 0} boxes` : 'no record; known keys: ' + (Object.keys(madeIndex()).join(' | ') || '(none)')}`)
    if (!rec || !rec.source) return null
    // Structured clone hands back an ArrayBuffer or a typed array; normalise.
    rec.source = rec.source instanceof Uint8Array ? rec.source : new Uint8Array(rec.source)
    return rec
  } catch (e) {
    console.warn('could not look up this file:', e.message)
    return null
  }
}

/** Returns how many boxes came back, so the toast can say so. */
function restoreMarks() {
  try {
    const raw = localStorage.getItem(storeKey())
    if (!raw) return 0
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved.marks) || !saved.marks.length) return 0
    state.marks = saved.marks
    state.seq = Math.max(saved.seq || 0, ...saved.marks.map(m => Number(m.id) || 0))
    return state.marks.length
  } catch (e) {
    console.warn('could not restore the boxes:', e.message)
    return 0
  }
}

function drawMarks() {
  document.querySelectorAll('.layer').forEach(l => { l.textContent = '' })
  for (const m of state.marks) {
    const wrap = document.querySelector(`.page[data-page="${m.page}"]`)
    if (!wrap) continue
    const layer = wrap.querySelector('.layer')
    const w = wrap.clientWidth, h = wrap.clientHeight
    const el = document.createElement('div')
    el.className = `mark ${m.type}${state.selected === m.id ? ' sel' : ''}`
    el.dataset.id = m.id       // so selection can find its element without a redraw
    el.style.left = `${m.xf * w}px`
    el.style.top = `${m.yf * h}px`

    if (m.type === 'text') {
      el.style.fontSize = `${m.sizeF * h}px`
      el.textContent = m.text
      // Edited where it sits. Typing into a sidebar box to change words that
      // are visibly on the page is a strange way round, and the focus needed to
      // make it work was being taken back by the click that placed it.
      if (state.editing === m.id) {
        el.contentEditable = 'true'
        el.spellcheck = false
        el.style.outline = '1px solid var(--accent)'
        el.addEventListener('input', () => { m.text = el.textContent })
        el.addEventListener('blur', () => {
          m.text = el.textContent
          state.editing = null
          drawMarks(); renderItems(); renderInspector()
        })
        el.addEventListener('keydown', (ev) => {
          ev.stopPropagation()                       // Delete must not remove the mark
          if (ev.key === 'Escape') el.blur()
        })
      }
    } else {
      el.style.width = `${m.wf * w}px`
      el.style.height = `${m.hf * h}px`
      if (m.type === 'image') {
        const img = document.createElement('img')
        img.src = m.dataUrl
        el.appendChild(img)
      }
      const grip = document.createElement('div')
      grip.className = 'grip'
      grip.addEventListener('pointerdown', (e) => startResize(e, m, wrap))
      el.appendChild(grip)
    }

    el.addEventListener('pointerdown', (e) => startDrag(e, m, wrap, el))
    // Double-click jumps straight to the text box in the inspector, which is
    // where editing lives now.
    // Double-click a text box to put the caret in it.
    el.addEventListener('dblclick', () => {
      if (m.type !== 'text') return
      state.editing = m.id
      drawMarks()          // rebuild once, to turn this one contentEditable
      select(m.id)
    })
    layer.appendChild(el)
  }

  // Focus after the elements exist, and on the next frame: focusing inside the
  // click that created it loses the caret to the browser's default action.
  if (state.editing != null) {
    requestAnimationFrame(() => {
      const el = [...document.querySelectorAll('.mark.text')]
        .find(x => x.isContentEditable)
      if (!el) return
      el.focus()
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)      // select the placeholder so typing replaces it
    })
  }
  persist()
}

function startDrag(e, m, wrap, el) {
  // While a box is being typed in, a click inside it belongs to the caret.
  if (state.editing === m.id) { e.stopPropagation(); return }
  e.stopPropagation()
  // Deliberately NO preventDefault() here. Calling it on a pointerdown
  // suppresses the compatibility mouse events -- click and dblclick with them --
  // so double-clicking an existing text box did nothing at all. Selection is
  // held off instead by user-select/touch-action in the stylesheet.
  if (state.selected !== m.id) select(m.id)
  const r = wrap.getBoundingClientRect()
  const dx = e.clientX - (r.left + m.xf * r.width)
  const dy = e.clientY - (r.top + m.yf * r.height)
  const startX = e.clientX, startY = e.clientY
  let moved = false
  const move = (ev) => {
    // Two or three pixels of hand jitter is a click, not a drag. The distinction
    // matters more than it looks: the redraw in up() replaces this element, and
    // a redraw landing between the two clicks of a double-click swallows the
    // dblclick -- which is exactly why an existing box could not be re-opened.
    if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return
    moved = true
    m.xf = Math.min(1, Math.max(0, (ev.clientX - dx - r.left) / r.width))
    m.yf = Math.min(1, Math.max(0, (ev.clientY - dy - r.top) / r.height))
    el.style.left = `${m.xf * r.width}px`
    el.style.top = `${m.yf * r.height}px`
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (moved) { drawMarks(); renderItems() }   // a plain click changes nothing
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function startResize(e, m, wrap) {
  e.stopPropagation()
  e.preventDefault()
  const r = wrap.getBoundingClientRect()
  const move = (ev) => {
    m.wf = Math.min(1, Math.max(0.02, (ev.clientX - (r.left + m.xf * r.width)) / r.width))
    m.hf = Math.min(1, Math.max(0.01, (ev.clientY - (r.top + m.yf * r.height)) / r.height))
    drawMarks()
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    renderItems()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/**
 * Selection is one place so the page, the list and the inspector never disagree.
 *
 * It deliberately does NOT redraw the marks. Rebuilding the layer on every
 * click destroyed the element the gesture was happening on, so the second click
 * of a double-click landed on a fresh node and the dblclick never fired -- a
 * box could be typed in when placed and never again. Only the outline changes,
 * so the DOM survives the gesture. The trade is that anything CHANGING the marks
 * -- placing, duplicating, deleting -- calls drawMarks() itself first.
 */
function select(id) {
  state.selected = id
  document.querySelectorAll('.mark.sel').forEach(el => el.classList.remove('sel'))
  if (id != null) document.querySelector(`.mark[data-id="${id}"]`)?.classList.add('sel')
  renderItems()
  renderInspector()
}

/**
 * Edit whatever is selected.
 *
 * Dragging a thing into place is only half of it -- the text is usually wrong
 * first time, and a white-out box is never the right size by eye. Double-click
 * did offer a prompt, but nothing said so, and the drag handler could swallow
 * the second click before it arrived.
 */
function renderInspector() {
  const box = $('inspector')
  box.textContent = ''
  const m = state.marks.find(x => x.id === state.selected)
  if (!m) {
    box.innerHTML = '<p class="muted pad small">Click anything you have placed to edit it.</p>'
    return
  }

  const field = (labelText, node) => {
    const wrap = document.createElement('div')
    wrap.className = 'field'
    const l = document.createElement('label')
    l.textContent = labelText
    wrap.append(l, node)
    return wrap
  }
  // Redraw the page but leave the sidebar alone: rebuilding the inputs while
  // someone is typing in them takes the caret with it.
  const live = () => drawMarks()

  if (m.type === 'text') {
    const ta = document.createElement('textarea')
    ta.value = m.text
    ta.addEventListener('input', () => { m.text = ta.value; live() })
    box.appendChild(field('Text', ta))

    const size = document.createElement('input')
    size.type = 'range'
    size.min = '6'; size.max = '48'; size.step = '0.5'
    size.value = String(Math.round(m.sizeF * 792))     // points on a letter page
    size.addEventListener('input', () => { m.sizeF = Number(size.value) / 792; live() })
    box.appendChild(field(`Size (${Math.round(m.sizeF * 792)}pt)`, size))
  } else {
    const two = document.createElement('div')
    two.className = 'two'
    for (const [key, name] of [['wf', 'Width %'], ['hf', 'Height %']]) {
      const l = document.createElement('label')
      const cap = document.createElement('span')
      cap.className = 'muted small'
      cap.textContent = name
      const inp = document.createElement('input')
      inp.className = 'input'
      inp.type = 'number'; inp.min = '1'; inp.max = '100'; inp.step = '1'
      inp.value = String(Math.round(m[key] * 100))
      inp.addEventListener('input', () => {
        const v = Number(inp.value)
        if (v > 0) { m[key] = Math.min(1, v / 100); live() }
      })
      l.append(cap, inp)
      two.appendChild(l)
    }
    box.appendChild(field(m.type === 'image' ? 'Signature size' : 'Box size', two))
  }

  const pos = document.createElement('div')
  pos.className = 'two'
  for (const [key, name] of [['xf', 'Across %'], ['yf', 'Down %']]) {
    const l = document.createElement('label')
    const cap = document.createElement('span')
    cap.className = 'muted small'
    cap.textContent = name
    const inp = document.createElement('input')
    inp.className = 'input'
    inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '1'
    inp.value = String(Math.round(m[key] * 100))
    inp.addEventListener('input', () => {
      const v = Number(inp.value)
      if (!Number.isNaN(v)) { m[key] = Math.min(1, Math.max(0, v / 100)); live() }
    })
    l.append(cap, inp)
    pos.appendChild(l)
  }
  box.appendChild(field(`Position on page ${m.page}`, pos))

  const actions = document.createElement('div')
  actions.className = 'actions'
  const dup = document.createElement('button')
  dup.className = 'btn tiny'
  dup.textContent = 'Duplicate'
  dup.addEventListener('click', () => {
    const copy = { ...m, id: ++state.seq, yf: Math.min(0.97, m.yf + 0.03) }
    state.marks.push(copy)
    drawMarks()
    select(copy.id)
  })
  const del = document.createElement('button')
  del.className = 'btn tiny danger'
  del.textContent = 'Delete'
  del.addEventListener('click', () => {
    state.marks = state.marks.filter(z => z.id !== m.id)
    drawMarks()
    select(null)
  })
  actions.append(dup, del)
  box.appendChild(actions)
}

function renderItems() {
  const box = $('items')
  box.textContent = ''
  if (!state.marks.length) {
    box.innerHTML = '<p class="muted pad small">Nothing placed yet.</p>'
    return
  }
  for (const m of state.marks) {
    const row = document.createElement('div')
    row.className = 'item'
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = m.type === 'image' ? 'signature' : m.type
    const label = document.createElement('span')
    label.textContent = m.type === 'text' ? m.text.slice(0, 24) : `page ${m.page}`
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '×'
    x.title = 'Remove'
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      state.marks = state.marks.filter(z => z.id !== m.id)
      drawMarks(); renderItems()
    })
    row.append(kind, label, x)
    row.addEventListener('click', () => {
      document.querySelector(`.page[data-page="${m.page}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      select(m.id)
    })
    box.appendChild(row)
  }
}

/* ── signature ───────────────────────────────────────────────────────── */

let sigPending = null
function openSignature(page, xf, yf) {
  sigPending = { page, xf, yf }
  $('signModal').hidden = false
}

function setupSignature() {
  const pad = $('sigPad')
  const ctx = pad.getContext('2d')
  ctx.lineWidth = 2.6
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#111'
  let drawing = false, empty = true

  const pos = (e) => {
    const r = pad.getBoundingClientRect()
    return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]
  }
  pad.addEventListener('pointerdown', (e) => {
    drawing = true; empty = false
    pad.setPointerCapture(e.pointerId)
    const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y)
  })
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return
    const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke()
  })
  pad.addEventListener('pointerup', () => { drawing = false })
  $('sigClear').addEventListener('click', () => { ctx.clearRect(0, 0, pad.width, pad.height); empty = true })

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t))
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('on', p.dataset.pane === t.dataset.tab))
  }))

  $('sigText').addEventListener('input', () => { $('sigPreview').textContent = $('sigText').value || 'Preview' })
  $('sigFile').addEventListener('change', async () => {
    const f = $('sigFile').files[0]
    if (!f) return
    const url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f) })
    const img = $('sigImg'); img.src = url; img.hidden = false
  })

  $('sigCancel').addEventListener('click', () => { $('signModal').hidden = true; sigPending = null })
  $('sigUse').addEventListener('click', () => {
    const active = document.querySelector('.tab.on').dataset.tab
    let dataUrl = null
    if (active === 'draw') {
      if (empty) return toast('Draw a signature first')
      dataUrl = trimToDataUrl(pad)
    } else if (active === 'type') {
      const text = $('sigText').value.trim()
      if (!text) return toast('Type your name first')
      dataUrl = textToDataUrl(text)
    } else {
      const img = $('sigImg')
      if (img.hidden || !img.src) return toast('Choose an image first')
      dataUrl = img.src
    }
    state.signature = dataUrl
    if ($('sigRemember').checked) { try { localStorage.setItem('pdf-signature', dataUrl) } catch { /* private window */ } }
    $('signModal').hidden = true
    if (sigPending) {
      addMark({ type: 'image', page: sigPending.page, xf: sigPending.xf, yf: sigPending.yf, wf: 0.22, hf: 0.07, dataUrl })
      sigPending = null
      setTool(null)
    }
  })

  try {
    const saved = localStorage.getItem('pdf-signature')
    if (saved) state.signature = saved
  } catch { /* private window */ }
}

/** Crop the drawn strokes so the signature does not arrive wrapped in space. */
function trimToDataUrl(canvas) {
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  const px = ctx.getImageData(0, 0, width, height).data
  let top = height, left = width, right = 0, bottom = 0, found = false
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 8) {
        found = true
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (!found) return canvas.toDataURL('image/png')
  const pad = 6
  const w = Math.min(width, right - left + pad * 2), h = Math.min(height, bottom - top + pad * 2)
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  out.getContext('2d').drawImage(canvas, Math.max(0, left - pad), Math.max(0, top - pad), w, h, 0, 0, w, h)
  return out.toDataURL('image/png')
}

function textToDataUrl(text) {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  const font = '64px "Segoe Script", "Bradley Hand", "Snell Roundhand", cursive'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 24
  c.width = w; c.height = 96
  const c2 = c.getContext('2d')
  c2.font = font
  c2.fillStyle = '#111'
  c2.textBaseline = 'middle'
  c2.fillText(text, 12, 52)
  return c.toDataURL('image/png')
}

/* ── saving ──────────────────────────────────────────────────────────── */

/**
 * Ask where the file goes -- and never before the bytes exist.
 *
 * Choosing an existing file in this dialog empties it there and then. Asking
 * first, while the document was still being built, meant a build that failed
 * afterwards left the chosen file destroyed: a real 1.9MB document became 0
 * bytes that way. So the bytes are always made first and this is called last,
 * and the cost is that a slow rebuild can outlast the click's transient
 * activation, in which case the browser refuses the dialog and the file goes to
 * the downloads folder instead. A clumsier save is a fair price for one that
 * cannot eat your work.
 */
async function pickTarget() {
  const handle = await window.showSaveFilePicker({
    suggestedName: state.name.replace(/\.pdf$/i, '') + '-filled.pdf',
    types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
  })
  state.saveHandle = handle
  return handle
}

/** Is this handle still writable? Permission can lapse between saves. */
async function canWrite(handle) {
  const opts = { mode: 'readwrite' }
  // Not every browser puts a permission API on the handle. Where it is missing,
  // assume writable and let createWritable() be the thing that objects: treating
  // an absent method as "refused" threw the handle away and opened the save
  // dialog a second time -- which is worse than useless, because the first
  // dialog has already created the file and it is still empty.
  if (typeof handle.queryPermission !== 'function') return true
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true
    return (await handle.requestPermission(opts)) === 'granted'
  } catch (e) {
    console.warn('permission check failed, trying the write anyway:', e.message)
    return true
  }
}

/**
 * One save path, so both routes behave identically.
 *
 * A plain download cannot overwrite: the browser keeps the old file and makes
 * -filled(1), -filled(2)... Chrome and Edge can hand back a real file handle
 * instead, so the first save asks where the file goes and every save after it
 * writes over that same file. Safari and Firefox have no such API and fall back
 * to the download, where the numbering is the browser's and not ours to fix.
 *
 * Returns the file name written, or null if the person cancelled.
 */
/** The name a save defaults to. */
function defaultSaveName() {
  return state.name.replace(/\.pdf$/i, '') + '-filled.pdf'
}

/**
 * Keep a typed name a file name, and keep it a PDF.
 *
 * Safari has no save dialog, so the folder is not ours to choose -- but the
 * name is, and being able to name the file is most of what "Save as" means.
 */
function ensurePdf(name) {
  const clean = String(name).trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '')
  if (!clean) return defaultSaveName()
  return /\.pdf$/i.test(clean) ? clean : clean + '.pdf'
}

/** Where the last save went, so the toast can say so rather than imply a choice. */
function savedWhere() {
  return state.lastSaveVia === 'download' ? ' to your Downloads folder' : ''
}

async function download(bytes, preferredName) {
  if (state.saveHandle) {
    try {
      if (await canWrite(state.saveHandle)) {
        const w = await state.saveHandle.createWritable()
        await w.write(bytes)
        await w.close()
        state.lastSaveVia = 'handle'
        return state.saveHandle.name
      }
    } catch (e) {
      console.warn('writing to the chosen file failed:', e.message)
      toast(`Could not write to that file (${e.message}) — pick another`, 8000)
      state.saveHandle = null            // fall through and ask again
    }
  }

  if (window.showSaveFilePicker) {
    try {
      const handle = await pickTarget()
      const w = await handle.createWritable()
      await w.write(bytes)
      await w.close()
      state.lastSaveVia = 'handle'
      return handle.name
    } catch (e) {
      if (e.name === 'AbortError') return null
      // NotAllowedError means the browser would not show the dialog, usually
      // because the rebuild outlasted the click. The download below still
      // delivers the file, so this is a downgrade rather than a failure.
      console.warn('save dialog unavailable:', e.name, e.message)
      toast('The browser would not open the save dialog, so this went to your downloads folder', 7000)
    }
  }

  const blob = new Blob([bytes], { type: 'application/pdf' })
  const a = document.createElement('a')
  const href = URL.createObjectURL(blob)
  a.href = href
  a.download = preferredName || defaultSaveName()
  // Put it IN the document before clicking. A detached anchor is ignored
  // outright by Firefox and cancelled by Chrome in some contexts -- and this is
  // the path every browser without a save dialog takes, Safari included, so it
  // is the one that has to be reliable rather than the one that usually works.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { a.remove(); URL.revokeObjectURL(href) }, 4000)
  state.lastSaveVia = 'download'
  return a.download
}

/**
 * Helvetica is WinAnsi: a tick, a dash pasted from Word, or an accented name
 * will not encode. Anything outside it is swapped for the nearest thing that
 * will, rather than failing the whole save.
 */
function winAnsi(s) {
  return String(s)
    .replace(/[✓✔]/g, 'X')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\xFF\n]/g, '?')
}

/**
 * The fallback for documents pdf-lib cannot rewrite at all.
 *
 * Encrypted PDFs are the usual case: pdf.js decrypts and displays them, while
 * pdf-lib cannot reach their page tree, so getPages() and save() both throw
 * "Expected instance of PDFDict" -- minified in the browser to the famously
 * unhelpful "Expected instance of n". Since pdf.js can clearly read the pages,
 * this rebuilds the file from what it renders and draws the marks on top.
 *
 * The result is flat: a picture of each page rather than its text. That is a
 * real loss -- no selectable text, no live form fields -- and it is also the
 * only way these documents can be saved at all, so it runs only after the
 * direct path has failed.
 */
async function saveByRerender() {
  const out = await PDFDocument.create()
  const helv = await out.embedFont(StandardFonts.Helvetica)
  const SCALE = 2                     // ~144dpi: sharp in print without being enormous

  for (let n = 1; n <= state.doc.numPages; n++) {
    console.info(`[pdf-editor] re-rendering page ${n} of ${state.doc.numPages}`)
    const src = await state.doc.getPage(n)
    // scale 1 gives the page size in points, already turned the right way up --
    // which is exactly the space the marks' fractions were recorded in, so the
    // rotation maths the direct path needs has no counterpart here.
    const box = src.getViewport({ scale: 1 })
    const viewport = src.getViewport({ scale: SCALE })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'                          // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await src.render({ canvasContext: ctx, viewport }).promise

    const W = box.width, H = box.height
    const page = out.addPage([W, H])
    const jpg = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.85))
    page.drawImage(jpg, { x: 0, y: 0, width: W, height: H })

    for (const m of state.marks.filter(z => z.page === n)) {
      const x = m.xf * W, yTop = H - m.yf * H
      if (m.type === 'text') {
        const size = m.sizeF * H
        page.drawText(winAnsi(m.text), {
          x, y: yTop - size, size, font: helv, color: rgb(0.07, 0.07, 0.07),
        })
      } else if (m.type === 'white') {
        page.drawRectangle({
          x, y: yTop - m.hf * H, width: m.wf * W, height: m.hf * H, color: rgb(1, 1, 1),
        })
      } else if (m.type === 'image') {
        const png = await out.embedPng(m.dataUrl)
        page.drawImage(png, { x, y: yTop - m.hf * H, width: m.wf * W, height: m.hf * H })
      }
    }
  }
  console.info('[pdf-editor] all pages rebuilt; writing the file')
  return out.save()
}

async function save(chosenName) {
  if (!state.bytes) return
  $('save').disabled = true

  // Which step we are on, so a failure names itself. pdf-lib's type errors are
  // minified to things like "Expected instance of n", which says nothing about
  // where it happened -- and guessing at that cost two rounds already.
  let step = 'opening the document'
  try {
    // Reopened from the original bytes every time: saving twice must produce
    // the same document, not one with the marks written on twice.
    const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true })
    step = 'embedding the font'
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    step = 'reading the pages'
    const pages = doc.getPages()

    // Form fields first, so flattening at the end catches them too.
    // Everything about the form is optional. A malformed AcroForm -- and
    // getForm() itself can refuse one, before any field is touched -- must not
    // cost you the text and the signature you actually came to add.
    if (state.fields.length) try {
      step = 'reading the form'
      const form = doc.getForm()
      for (const f of state.fields) {
        try {
          step = `filling field "${f.name}"`
          // Look the field up and ask what it IS, rather than trusting a typed
          // getter to match a label recorded earlier.
          const field = form.getField(f.name)
          const kind = fieldKind(field)
          if (kind === 'check') {
            f.value ? field.check() : field.uncheck()
          } else if (kind === 'dropdown' || kind === 'radio') {
            if (f.value) field.select(f.value)
          } else if (kind === 'text') {
            field.setText(String(f.value ?? ''))
          }
        } catch (e) {
          // One awkward field must not cost the whole save.
          console.warn(`field ${f.name}:`, e.message)
        }
      }
    } catch (e) {
      console.warn('form skipped:', e.message)
      toast(`Form fields skipped (${e.message.slice(0, 60)}) — your text and signature were still saved`, 6000)
    }

    for (const m of state.marks) {
      const page = pages[m.page - 1]
      if (!page) continue
      const { width, height } = page.getSize()
      // A page can carry a rotation, and pdf-lib draws in unrotated space. The
      // fractions came from what was on screen, which pdf.js had already turned
      // the right way up, so they are mapped back here.
      const rot = ((page.getRotation().angle % 360) + 360) % 360
      const put = (xf, yf, wf, hf) => {
        const sw = (rot === 90 || rot === 270) ? height : width
        const sh = (rot === 90 || rot === 270) ? width : height
        const x = xf * sw, yTop = yf * sh, w = (wf ?? 0) * sw, h = (hf ?? 0) * sh
        if (rot === 90) return { x: yTop, y: x, w: h, h: w }
        if (rot === 180) return { x: sw - x - w, y: yTop, w, h }
        if (rot === 270) return { x: sh - yTop - h, y: sw - x - w, w: h, h: w }
        return { x, y: sh - yTop, w, h }
      }

      if (m.type === 'text') {
        step = `drawing text "${String(m.text).slice(0, 20)}" on page ${m.page}`
        const size = m.sizeF * ((rot === 90 || rot === 270) ? width : height)
        const p = put(m.xf, m.yf)
        page.drawText(winAnsi(m.text), {
          x: p.x, y: p.y - size, size, font: helv, color: rgb(0.07, 0.07, 0.07),
          rotate: degrees(rot === 0 ? 0 : 360 - rot),
        })
      } else if (m.type === 'white') {
        const p = put(m.xf, m.yf, m.wf, m.hf)
        page.drawRectangle({ x: p.x, y: p.y - p.h, width: p.w, height: p.h, color: rgb(1, 1, 1) })
      } else if (m.type === 'image') {
        step = `embedding the signature on page ${m.page}`
        const png = await doc.embedPng(m.dataUrl)
        const p = put(m.xf, m.yf, m.wf, m.hf)
        page.drawImage(png, { x: p.x, y: p.y - p.h, width: p.w, height: p.h })
      }
    }

    if ($('flatten').checked && state.fields.length) {
      try { doc.getForm().flatten() } catch (e) { console.warn('flatten:', e.message) }
    }

    const outBytes = await doc.save()
    const saved = await download(outBytes, chosenName)
    if (saved) await rememberSave(saved, outBytes.length)
    toast(saved ? `Saved ${saved}${savedWhere()}` : 'Save cancelled')
  } catch (e) {
    // The direct rewrite failed. Rather than hand back nothing, rebuild the
    // document from the pages pdf.js has already rendered -- see saveByRerender().
    console.error(`PDF save failed while ${step}:`, e)
    try {
      toast('This PDF cannot be rewritten directly — saving a flattened copy…', 5000)
      const outBytes = await saveByRerender()
      const saved = await download(outBytes, chosenName)
      if (!saved) { toast('Save cancelled'); return }
      // The source kept here is the untouched original, so a later edit
      // re-flattens from it rather than flattening an already-flat page again.
      await rememberSave(saved, outBytes.length)
      const lostFields = state.fields.some(f => f.value)
      toast(lostFields
        ? `Saved ${saved}${savedWhere()}, flattened. Values typed in the Form fields panel are not in it — type those on the page instead.`
        : `Saved ${saved}${savedWhere()} as a flattened copy (this PDF could not be edited in place).`, 8000)
    } catch (e2) {
      // Both routes failed. Say so on screen, with BOTH reasons: the second one
      // is the useful one, and it was previously only in the console. Mention
      // the empty file too -- the save dialog creates it before anything is
      // written, so a failure here leaves a 0-byte file sitting there.
      console.error('rerender fallback failed:', e2)
      toast(`Could not save. Direct: ${e.message} | Flattened: ${e2.message}`
        + (state.saveHandle ? ` — "${state.saveHandle.name}" was left empty; delete it.` : ''), 15000)
    }
  } finally {
    $('save').disabled = false
  }
}

/* ── wiring ──────────────────────────────────────────────────────────── */

$('fileInput').addEventListener('change', (e) => openFile(e.target.files[0]))
$('toolText').addEventListener('click', () => setTool('text'))
$('toolSign').addEventListener('click', () => setTool('sign'))
$('toolWhite').addEventListener('click', () => setTool('white'))
$('toolCheck').addEventListener('click', () => setTool('check'))
$('save').addEventListener('click', save)
// Forget where the last save went, so the picker asks for a new file.
$('saveAs').addEventListener('click', () => {
  // Where a save dialog exists, forget the last file so the dialog asks again.
  if (window.showSaveFilePicker) { state.saveHandle = null; return save() }
  // Where one does not -- Safari, Firefox -- the folder is fixed and only the
  // name is ours. Asking for it is the honest remainder of "Save as", and it
  // also sidesteps the browser's -1, -2 numbering of repeated downloads.
  const name = prompt('Save as (this browser always saves to your Downloads folder):', defaultSaveName())
  if (name === null) return toast('Save cancelled')
  save(ensurePdf(name))
})
$('sideToggle').addEventListener('click', () => $('side').classList.toggle('hidden'))
$('zoomIn').addEventListener('click', async () => { state.zoom = Math.min(3, state.zoom + 0.15); if (state.doc) await renderAll() })
$('zoomOut').addEventListener('click', async () => { state.zoom = Math.max(0.4, state.zoom - 0.15); if (state.doc) await renderAll() })

const stage = $('stage')
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag') })
stage.addEventListener('dragleave', () => stage.classList.remove('drag'))
stage.addEventListener('drop', (e) => {
  e.preventDefault()
  stage.classList.remove('drag')
  openFile(e.dataTransfer.files[0])
})

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    state.marks = state.marks.filter(m => m.id !== state.selected)
    drawMarks()
    select(null)
  }
  if (e.key === 'Escape') setTool(null)
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
})

/**
 * One command to see what is remembered, for when reopening a saved file does
 * not bring its boxes back: run pdfEditorDebug() in the console.
 */
window.pdfEditorDebug = async () => {
  const rows = []
  for (const [key, at] of Object.entries(madeIndex())) {
    let rec = null
    try { rec = await dbDo('readonly', s => s.get(key)) } catch {}
    rows.push({
      'saved file': key, boxes: rec?.marks?.length ?? '(record missing)',
      'made from': rec?.sourceName ?? '', when: new Date(at).toLocaleString(),
    })
  }
  console.log(`build ${BUILD}`)
  console.table(rows)
  const loose = Object.keys(localStorage).filter(k => k.startsWith('pdfedit:') && k !== 'pdfedit:made-index')
  console.log('boxes remembered against an opened file:', loose.length ? loose : '(none)')
  return `${rows.length} saved document(s) remembered`
}

/**
 * Get back a document whose file was lost or emptied.
 *
 * Every successful save stored what it was made from -- the source bytes and
 * the boxes -- so that record outlives the file on disk. Call with the key
 * pdfEditorDebug() printed, e.g. pdfEditorRecover('I-864a_newtest.pdf:1924347'),
 * and the document comes back with its boxes editable, ready to save again.
 */
window.pdfEditorRecover = async (key) => {
  if (!key) return 'pass a key, e.g. pdfEditorRecover("file.pdf:123456") — run pdfEditorDebug() to list them'
  let rec
  try { rec = await dbDo('readonly', s => s.get(key)) } catch (e) { return `lookup failed: ${e.message}` }
  if (!rec || !rec.source) return `nothing stored under "${key}" — run pdfEditorDebug() to see what is`

  state.bytes = rec.source instanceof Uint8Array ? rec.source : new Uint8Array(rec.source)
  state.name = rec.sourceName || 'recovered.pdf'
  state.marks = Array.isArray(rec.marks) ? rec.marks : []
  state.seq = rec.seq || state.marks.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0)
  state.selected = null
  state.saveHandle = null           // save it somewhere new, not over the wreck
  $('docName').textContent = state.name
  $('empty').hidden = true
  $('save').disabled = false
  $('saveAs').disabled = false

  state.doc = await pdfjsLib.getDocument({ data: state.bytes.slice(), password: '' }).promise
  state.marks = state.marks.filter(m => m.page >= 1 && m.page <= state.doc.numPages)
  await renderAll()
  await readFormFields()
  renderItems()
  toast(`Recovered ${state.marks.length} box${state.marks.length === 1 ? '' : 'es'} — save this to a NEW file`, 9000)
  return `recovered ${state.marks.length} boxes onto ${state.name}`
}

// Say what the button can actually do here, rather than promising a dialog
// this browser has no way to show.
if (!window.showSaveFilePicker) {
  $('saveAs').title = 'This browser has no save dialog — you choose the name, and it goes to your Downloads folder'
  $('save').title = 'Saves to your Downloads folder'
}

$('build').textContent = BUILD
setupSignature()
renderItems()
renderInspector()

import {FirebaseEngine, MockEngine, type DeviceState, type Engine} from '../ai/engine.ts'
import {Runner, Stopped, type Policy} from '../ai/runner.ts'
import {categoriseTask, draftTask, explainTask, questionTask, readCategories, readQuestion, summaryFacts, summaryTask, type Task, type Tone} from '../ai/tasks.ts'
import {findAlerts, looseChange} from '../core/alerts.ts'
import {answer, parseQuestion, targetForCategory, targetWithoutModel, type Answer, type Target} from '../core/ask.ts'
import {CATEGORIES, category} from '../core/categories.ts'
import {Classifier, REVIEW_BELOW} from '../core/classify.ts'
import {importStatement, toCsv} from '../core/csv.ts'
import {formatDay, isoDay, monthLabel} from '../core/dates.ts'
import {money, plural} from '../core/money.ts'
import {findRecurring, upcoming} from '../core/recurring.ts'
import {sampleStatement} from '../core/sample.ts'
import {summarise, type Summary} from '../core/summary.ts'
import type {Alert, CategoryId, ImportResult, Recurring, Txn, Verdict} from '../core/types.ts'

const TAUGHT_KEY = 'clawback:taught'
const POLICY_KEY = 'clawback:policy'
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** Statement text and model output are both untrusted: everything shown goes through this. */
function e(text: string | number): string {
  return String(text).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[ch]!)
}

// ---------------------------------------------------------------- the AI

const query = new URLSearchParams(location.search)
const engine: Engine =
  query.get('ai') === 'mock'
    ? new MockEngine(query.get('device') === 'off' ? 'downloadable' : 'available', query.get('cloud') !== 'off')
    : new FirebaseEngine()
let device: DeviceState = 'unavailable'

function policy(): Policy {
  try {
    const saved = localStorage.getItem(POLICY_KEY)
    return saved === 'device' || saved === 'allow' ? saved : 'ask'
  } catch {
    return 'ask'
  }
}

/** Shows the exact text that would leave the device and waits for a yes or a no. */
function askConsent(task: Task): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('consent')
  const text = `${task.system}\n\n${task.prompt}`
  $('consent-text').textContent = text
  $('consent-size').textContent = `${task.label} · ${text.length} characters · sent to Gemini through Firebase AI Logic, protected by App Check`
  return new Promise(resolve => {
    const done = (yes: boolean) => {
      $('consent-yes').onclick = null
      $('consent-no').onclick = null
      dialog.oncancel = null
      if (dialog.open) dialog.close()
      resolve(yes)
    }
    $('consent-yes').onclick = () => done(true)
    $('consent-no').onclick = () => done(false)
    dialog.oncancel = () => done(false)
    dialog.showModal()
  })
}

const runner = new Runner(engine, policy, askConsent, () => paintAi())

async function refreshDevice(): Promise<void> {
  device = await engine.deviceState()
  paintAi()
}

function paintAi(): void {
  const pill = $('ai-pill')
  const sent = runner.sentChars()
  const text =
    device === 'available'
      ? 'AI runs on this device'
      : device === 'downloading'
        ? 'On-device model is downloading'
        : device === 'downloadable'
          ? 'On-device model not downloaded yet'
          : 'No on-device model in this browser'
  $('ai-pill-text').textContent = sent ? `${text} · ${sent.toLocaleString('en-US')} characters sent to the cloud` : `${text} · nothing sent`
  pill.dataset.state = device === 'available' ? 'device' : sent ? 'cloud' : 'waiting'
  $('ai-device-line').textContent =
    device === 'available'
      ? 'Gemini Nano is ready in this browser. Requests run with the ONLY_ON_DEVICE mode of Firebase AI Logic and never leave this device.'
      : device === 'unavailable'
        ? 'This browser has no built-in model (it needs a recent desktop Chrome). The choice below decides what happens instead.'
        : 'Chrome can run Gemini Nano on this device, but the model has not been downloaded yet.'
  $('ai-download').hidden = device !== 'downloadable' && device !== 'downloading'
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="policy"]')) {
    radio.checked = radio.value === policy()
    if (radio.value !== 'device') radio.disabled = !engine.cloudConfigured()
  }
  $('ledger-total').textContent = runner.ledger.length
    ? `${plural(runner.ledger.length, 'request')} so far: ${runner.ledger.filter(l => l.where === 'device').length} on this device, ${runner.ledger.filter(l => l.where === 'cloud').length} in the cloud (${sent.toLocaleString('en-US')} characters sent).`
    : 'No AI request has been made yet.'
  $('ledger').innerHTML = runner.ledger
    .slice()
    .reverse()
    .map(l => `<li class="${l.where}"><div><b>${e(l.label)}</b><span>${l.where === 'device' ? 'on this device' : 'in the cloud, with your OK'} · ${(l.ms / 1000).toFixed(1)} s</span></div>${l.sent ? `<details><summary>What was sent (${l.sent.length} characters)</summary><pre>${e(l.sent)}</pre></details>` : ''}</li>`)
    .join('')
}

/** A short line for the person, whatever stopped the request. */
function reasonText(err: unknown): string {
  if (err instanceof Stopped) {
    if (err.reason === 'declined') return 'Nothing was sent.'
    if (err.reason === 'no-device') return 'The on-device model is not ready, and you chose to keep everything on this device. Open “Where the AI runs” to download it or change that.'
    return 'The on-device model is not ready and no cloud service is set up for this copy of the app.'
  }
  console.error(err)
  return 'The model could not answer just now. Try again in a moment.'
}

// ---------------------------------------------------------------- state

interface State {
  fileName: string
  imported: ImportResult
  verdicts: Verdict[]
  summary: Summary
  recurring: Recurring[]
  alerts: Alert[]
  picked: {ids: Set<number>; label: string} | null
  onlyCategory: CategoryId | ''
  search: string
  shown: number
  dropped: Set<string>
  reply: {question: string; answer: Answer; understood: string} | null
  /** The plain-language summary, once asked for. */
  plain: {text: string; note: string} | null
  /** What happened the last time unfamiliar merchants were sent to the model. */
  sortNote: string
  sorting: boolean
}
let state: State | null = null
const classifier = new Classifier()

function loadTaught(): {text: string; category: CategoryId}[] {
  try {
    const list = JSON.parse(localStorage.getItem(TAUGHT_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter(x => typeof x?.text === 'string' && CATEGORIES.some(c => c.id === x.category)) : []
  } catch {
    return []
  }
}

function saveTaught(): void {
  try {
    localStorage.setItem(TAUGHT_KEY, JSON.stringify(classifier.taught))
  } catch {
    // Private windows may refuse storage; teaching still works until the tab closes.
  }
}

function classifyAll(s: State): void {
  s.verdicts = s.imported.txns.map(t => classifier.classify(t.merchant, t.raw, t.amount))
  s.summary = summarise(s.imported.txns, s.verdicts)
  s.recurring = findRecurring(s.imported.txns, s.verdicts, s.summary.endDay)
  s.alerts = findAlerts(s.imported.txns, s.verdicts, s.recurring, s.summary.startDay, s.summary.endDay)
}

function unfamiliar(s: State): string[] {
  return [...new Set(s.imported.txns.filter(t => t.amount < 0 && classifier.needsModel(t.merchant, t.raw, t.amount)).map(t => t.merchant))]
}

function open(text: string, fileName: string): void {
  const imported = importStatement(text)
  const error = $('start-error')
  if (!imported.txns.length) {
    error.hidden = false
    error.textContent = `That file could not be read as a statement. ${imported.skipped[0]?.why ?? ''} Export your transactions as CSV from your bank's website and try again.`
    return
  }
  error.hidden = true
  classifier.ai.clear()
  for (const t of loadTaught()) if (!classifier.taught.some(x => x.text === t.text)) classifier.teach(t.text, t.category)
  state = {
    fileName, imported, verdicts: [], summary: summarise([], []), recurring: [], alerts: [],
    picked: null, onlyCategory: '', search: '', shown: 60, dropped: new Set(), reply: null, plain: null, sortNote: '', sorting: false,
  }
  classifyAll(state)
  $('start').hidden = true
  $('app').hidden = false
  mountOnce()
  paint()
  window.scrollTo({top: 0})
  // Sorting on this device needs no permission, so it starts by itself. Anything that would
  // leave the device waits for the person to press the button and see what would be sent.
  const s = state
  void refreshDevice().then(() => {
    if (state === s && device === 'available') void sortUnfamiliar(s)
  })
}

/** Asks the model to place the merchants no rule could, a batch at a time. */
async function sortUnfamiliar(s: State): Promise<void> {
  if (s.sorting) return
  s.sorting = true
  s.sortNote = ''
  paintStatus()
  try {
    for (;;) {
      const batch = unfamiliar(s).slice(0, 15)
      if (!batch.length || state !== s) break
      const reply = await runner.run(categoriseTask(batch))
      const read = readCategories(reply.text, batch)
      // Whatever the model skipped is marked as tried, so the loop always moves on.
      for (const m of batch) classifier.ai.set(m, {category: read.get(m)?.category ?? 'other', sure: read.get(m)?.sure ?? false, where: reply.where})
      classifyAll(s)
      paint()
    }
  } catch (err) {
    s.sortNote = reasonText(err)
  }
  s.sorting = false
  if (state === s) paint()
}

// ---------------------------------------------------------------- painting

function paintStatus(): void {
  const el = $('model-status')
  if (!state) return
  const left = unfamiliar(state).length
  el.textContent = state.sorting ? `Sorting ${plural(left, 'unfamiliar merchant')} with the model` : left ? `${plural(left, 'merchant')} not sorted yet` : 'Every merchant sorted'
  el.dataset.state = state.sorting ? 'busy' : left ? 'idle' : 'ready'
}

function chip(id: CategoryId): string {
  return `<span class="chip c-${id}">${e(category(id).label)}</span>`
}

function paint(): void {
  if (!state) return
  const s = state
  const {summary} = s
  const txns = s.imported.txns
  $('file-line').innerHTML = `<b>${e(s.fileName)}</b> · ${formatDay(summary.startDay)} to ${formatDay(summary.endDay)} · ${plural(txns.length, 'line')}${s.imported.skipped.length ? ` · <span class="warn">${plural(s.imported.skipped.length, 'line')} could not be read</span>` : ''}${s.imported.flipped ? ' · <span title="This file listed purchases as positive numbers, so the signs were turned round.">signs turned round</span>' : ''}`

  const loose = looseChange(s.alerts)
  const regular = s.recurring.filter(r => r.active && r.category !== 'transfers')
  const regularYear = regular.reduce((sum, r) => sum + r.yearly, 0)
  $('headline').innerHTML = `
    <div class="receipt">
      <p class="eyebrow">What your statement says</p>
      ${loose > 0
        ? `<h1><span class="big">${money(loose, true)}</span> <span class="big-after">a year is leaking</span></h1>
           <p class="sub">That is what the bank fees, price rises and double charges below add up to if nothing changes. Each one has a message ready to be written.</p>`
        : `<h1><span class="big-after">No fees, price rises or double charges found.</span></h1><p class="sub">Your regular charges are still worth a look below.</p>`}
      <dl class="tiles">
        <div><dt>Money out</dt><dd>${money(summary.spent, true)}</dd><small>${money(summary.perDay)} a day</small></div>
        <div><dt>Money in</dt><dd>${money(summary.cameIn, true)}</dd><small>${summary.cameIn >= summary.spent ? `${money(summary.cameIn - summary.spent, true)} more than you spent` : `${money(summary.spent - summary.cameIn, true)} less than you spent`}</small></div>
        <div><dt>Regular charges</dt><dd>${money(regularYear, true)}</dd><small>a year, across ${plural(regular.length, 'charge')}</small></div>
        <div><dt>Moved, not spent</dt><dd>${money(summary.moved, true)}</dd><small>to savings, cards or people</small></div>
      </dl>
      <div class="plain">
        ${s.plain ? `<p class="plain-text" id="plain-text">${e(s.plain.text)}</p><p class="where-line">${e(s.plain.note)}</p>` : `<button type="button" class="btn quiet" data-act="plain">Put it in plain words</button><span class="hint">Written by the model from these numbers.</span>`}
      </div>
    </div>`

  const tag = (a: Alert): string => {
    if (a.kind === 'duplicate') return `<b>${money(a.amount)}</b><span>to ask back</span>`
    if (a.kind === 'price_rise') return `<b>+${money(a.yearly ?? 0, true)}</b><span>a year</span>`
    if (a.kind === 'fee') return `<b>${money(a.yearly ?? 0, true)}</b><span>a year at this rate</span>`
    if (a.kind === 'overlap') return `<b>${money(a.yearly ?? 0, true)}</b><span>a year you could free</span>`
    if (a.kind === 'unusual') return `<b>${money(a.amount)}</b><span>one charge</span>`
    return `<b>${money(a.yearly ?? 0, true)}</b><span>a year</span>`
  }
  const mark: Record<Alert['kind'], string> = {duplicate: '2×', price_rise: '↑', fee: '%', overlap: '≡', new_recurring: 'new', trial: '$1', unusual: '!'}
  $('alerts').innerHTML = `
    <h2 id="alerts-h">Worth asking about <span class="count">${s.alerts.length}</span></h2>
    ${s.alerts.length ? `<ul class="alerts">${s.alerts.map((a, i) => `
      <li class="alert k-${a.kind}">
        <span class="mark" aria-hidden="true">${mark[a.kind]}</span>
        <div class="alert-body"><h3>${e(a.title)}</h3><p>${e(a.detail)}</p>
          <p class="alert-actions"><button type="button" class="btn small" data-act="draft" data-i="${i}">Write the message</button><button type="button" class="link" data-act="alert-lines" data-i="${i}">See the ${plural(a.txnIds.length, 'line')}</button></p></div>
        <div class="alert-side">${tag(a)}</div>
      </li>`).join('')}</ul>` : '<p class="empty">Nothing stood out. No double charges, price rises or bank fees in this statement.</p>'}`

  const soon = upcoming(s.recurring, summary.endDay)
  const soonTotal = soon.reduce((sum, u) => sum + u.amount, 0)
  const back = s.recurring.filter(r => s.dropped.has(r.merchant)).reduce((sum, r) => sum + r.yearly, 0)
  $('regular').innerHTML = `
    <h2 id="regular-h">Regular charges <span class="count">${s.recurring.length}</span></h2>
    ${s.recurring.length ? `
    <p class="section-note">Found by the rhythm of the dates, not by a list of names. In the 30 days after this statement expect <b>${money(soonTotal, true)}</b> across ${plural(soon.length, 'charge')}. Tick anything you would drop.</p>
    <div class="table-wrap"><table class="regular">
      <thead><tr><th scope="col"><span class="sr">Drop</span></th><th scope="col">Who</th><th scope="col">How often</th><th scope="col" class="num">Each time</th><th scope="col" class="num">A year</th><th scope="col">Next</th><th scope="col"><span class="sr">Lines</span></th></tr></thead>
      <tbody>${s.recurring.map((r, i) => `
        <tr class="${r.active ? '' : 'stopped'}${s.dropped.has(r.merchant) ? ' dropped' : ''}">
          <td><input type="checkbox" data-act="drop" data-i="${i}" aria-label="I would drop ${e(r.label)}" ${s.dropped.has(r.merchant) ? 'checked' : ''} ${r.active ? '' : 'disabled'}></td>
          <th scope="row"><span class="who">${e(r.label)}</span> ${chip(r.category)}${r.kind ? ` <span class="kind">${e(r.kind)}</span>` : ''}${r.rise ? ` <span class="rise" title="Was ${money(r.rise.from)} until ${formatDay(r.rise.day)}">↑ from ${money(r.rise.from)}</span>` : ''}</th>
          <td>${e(r.cadence)}</td>
          <td class="num">${money(r.typical)}</td>
          <td class="num"><b>${money(r.yearly, true)}</b></td>
          <td>${r.active ? formatDay(r.nextDay, false) : `<span class="muted">stopped ${formatDay(r.lastDay, false)}</span>`}</td>
          <td><button type="button" class="link" data-act="regular-lines" data-i="${i}">${plural(r.count, 'line')}</button></td>
        </tr>`).join('')}</tbody>
    </table></div>
    <p class="back ${back ? 'on' : ''}" aria-live="polite">${back ? `Dropping the ${plural(s.dropped.size, 'ticked charge')} would give you back <b>${money(back, true)} a year</b>.` : 'Nothing ticked yet.'}</p>` : '<p class="empty">No charge in this statement comes round on a rhythm. A longer statement (three months or more) shows more.</p>'}`

  // Merchants the model has not placed, or placed without being sure.
  const waiting = unfamiliar(s)
  const unsure = new Map<string, {label: string; count: number; total: number; verdict: Verdict}>()
  for (const t of txns) {
    const v = s.verdicts[t.id]!
    if (t.amount >= 0 || v.confidence >= REVIEW_BELOW || waiting.includes(t.merchant)) continue
    const u = unsure.get(t.merchant) ?? {label: t.label, count: 0, total: 0, verdict: v}
    u.count++
    u.total -= t.amount
    unsure.set(t.merchant, u)
  }
  const queue = [...unsure].sort((a, b) => b[1].total - a[1].total)
  const options = CATEGORIES.filter(c => c.id !== 'income').map(c => `<option value="${c.id}">${e(c.label)}</option>`).join('')
  $('review').hidden = !queue.length && !waiting.length
  $('review').innerHTML = `
    <h2 id="review-h">Not sure about these <span class="count">${queue.length + waiting.length}</span></h2>
    ${waiting.length ? `<div class="sort-box"><p><b>${plural(waiting.length, 'merchant')}</b> no rule could place: ${e(waiting.slice(0, 6).join(', '))}${waiting.length > 6 ? ` and ${waiting.length - 6} more` : ''}.</p>
      <p><button type="button" class="btn small" data-act="sort" ${s.sorting ? 'disabled' : ''}>${s.sorting ? 'Sorting…' : 'Sort them with the model'}</button> <span class="hint">${device === 'available' ? 'Runs on this device.' : 'The on-device model is not ready; you will be shown what would be sent first.'}</span></p>
      ${s.sortNote ? `<p class="warn" role="status">${e(s.sortNote)}</p>` : ''}</div>` : ''}
    ${queue.length ? `<p class="section-note">The model marked these as guesses instead of pretending. Tell it once and it is remembered on this device.</p>
    <ul class="review">${queue.slice(0, 8).map(([merchant, u], n) => `
      <li>
        <div class="review-who"><b>${e(u.label)}</b><span>${plural(u.count, 'payment')}, ${money(u.total)}</span></div>
        <div class="review-pick" data-merchant="${e(merchant)}">
          ${u.verdict.category !== 'other' ? `<button type="button" class="guess c-${u.verdict.category}" data-act="teach" data-category="${u.verdict.category}">${e(category(u.verdict.category).label)}</button>` : ''}
          <label class="sr" for="pick-${n}">Category for ${e(u.label)}</label>
          <select id="pick-${n}" data-act="teach-select"><option value="">Something else…</option>${options}</select>
        </div>
      </li>`).join('')}</ul>` : ''}`

  paintWhere(s)
  paintReply(s)
  paintLines(s)
  paintStatus()
}

function paintWhere(s: State): void {
  const {summary} = s
  const months = summary.months
  const W = 720
  const H = 250
  const padT = 16
  const padL = 46
  const padB = 26
  const top = Math.max(1, ...months.map(m => [...summary.byMonth.get(m)!.values()].reduce((a, b) => a + b, 0)))
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].map(d => d * 100).find(d => top / d <= 4) ?? Math.ceil(top / 4)
  const ceiling = Math.ceil(top / step) * step
  const slot = (W - padL) / months.length
  const barW = Math.min(64, slot * 0.62)
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / ceiling)
  const order = CATEGORIES.filter(c => c.spending).map(c => c.id)
  let bars = ''
  for (let line = 0; line <= ceiling; line += step) {
    bars += `<line x1="${padL}" x2="${W}" y1="${y(line).toFixed(1)}" y2="${y(line).toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y(line) + 4).toFixed(1)}" class="axis" text-anchor="end">${money(line, true)}</text>`
  }
  months.forEach((m, i) => {
    const x = padL + slot * i + (slot - barW) / 2
    let base = 0
    const cats = summary.byMonth.get(m)!
    for (const id of order) {
      const v = cats.get(id) ?? 0
      if (!v) continue
      const h = ((H - padB - padT) * v) / ceiling
      bars += `<rect x="${x.toFixed(1)}" y="${(y(base) - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, h - 1).toFixed(1)}" class="seg c-${id}${s.onlyCategory && s.onlyCategory !== id ? ' dim' : ''}" data-act="category" data-category="${id}"><title>${e(category(id).label)}, ${monthLabel(m)}: ${money(v)}</title></rect>`
      base += v
    }
    bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" class="axis" text-anchor="middle">${monthLabel(m).slice(0, 3)}</text><text x="${(x + barW / 2).toFixed(1)}" y="${(y(base) - 6).toFixed(1)}" class="total" text-anchor="middle">${money(base, true)}</text>`
  })
  const max = summary.byCategory[0]?.total ?? 1
  $('where').innerHTML = `
    <h2 id="where-h">Where it goes</h2>
    <div class="where">
      <figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending by month, stacked by category">${bars}</svg><figcaption>Spending by month. Transfers to savings, cards and people are left out.</figcaption></figure>
      <ul class="cats">${summary.byCategory.map(c => `
        <li><button type="button" class="cat-row${s.onlyCategory === c.id ? ' on' : ''}" data-act="category" data-category="${c.id}" aria-pressed="${s.onlyCategory === c.id}">
          <span class="swatch c-${c.id}" aria-hidden="true"></span><span class="cat-name">${e(category(c.id).label)}</span>
          <svg class="cat-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width="${((c.total / max) * 100).toFixed(1)}" height="6" class="seg c-${c.id}"/></svg>
          <span class="cat-total">${money(c.total, true)}</span><span class="cat-share">${Math.round((c.total / Math.max(1, summary.spent)) * 100)}%</span>
        </button></li>`).join('')}</ul>
    </div>`
}

function paintReply(s: State): void {
  const el = $('answer')
  if (!s.reply) {
    el.innerHTML = ''
    return
  }
  const {answer: a, understood} = s.reply
  el.innerHTML = `<div class="reply"><p class="reply-main">${e(a.text)}</p><p class="reply-detail">${e(a.detail)}</p><p class="reply-how">Understood as: ${e(understood)}${a.txnIds.length ? ` · <button type="button" class="link" data-act="reply-lines">See the ${plural(a.txnIds.length, 'line')}</button>` : ''}</p></div>`
}

function visible(s: State): Txn[] {
  const words = s.search.toLowerCase().split(/\s+/).filter(Boolean)
  return s.imported.txns.filter(t => {
    if (s.picked && !s.picked.ids.has(t.id)) return false
    if (s.onlyCategory && s.verdicts[t.id]!.category !== s.onlyCategory) return false
    if (words.length) {
      const hay = `${t.raw} ${t.label} ${category(s.verdicts[t.id]!.category).label}`.toLowerCase()
      if (!words.every(w => hay.includes(w))) return false
    }
    return true
  })
}

function paintLines(s: State): void {
  const rows = visible(s).reverse()
  const total = rows.reduce((sum, t) => sum + t.amount, 0)
  const options = (now: CategoryId) => CATEGORIES.map(c => `<option value="${c.id}"${c.id === now ? ' selected' : ''}>${e(c.label)}</option>`).join('')
  const filters: string[] = []
  if (s.picked) filters.push(`<button type="button" class="filter" data-act="clear-picked">${e(s.picked.label)} ✕</button>`)
  if (s.onlyCategory) filters.push(`<button type="button" class="filter" data-act="clear-category">${e(category(s.onlyCategory).label)} ✕</button>`)
  $('filters').innerHTML = filters.join('')
  $('line-count').textContent = `${plural(rows.length, 'line')}, net ${money(total)}`
  const how = (v: Verdict): string => (v.reason.how === 'known' ? 'known merchant' : v.reason.how === 'taught' ? 'you taught it' : v.reason.how === 'ai' ? (v.reason.where === 'device' ? 'model, on device' : 'model, cloud') : 'rule')
  $('rows').innerHTML = rows.slice(0, s.shown).map(t => {
    const v = s.verdicts[t.id]!
    const unsure = t.amount < 0 && v.confidence < REVIEW_BELOW
    return `<tr class="${unsure ? 'unsure' : ''}">
      <td class="date">${formatDay(t.day, false)}</td>
      <td class="desc"><b>${e(t.label)}</b><small>${e(t.raw)}</small></td>
      <td class="cat"><select class="chip-select c-${v.category}" data-act="recat" data-id="${t.id}" aria-label="Category for ${e(t.label)}" ${t.amount > 0 ? 'disabled' : ''}>${options(v.category)}</select><button type="button" class="why-btn${unsure ? ' unsure' : ''}" data-act="why" data-id="${t.id}" aria-label="Why ${e(category(v.category).label)}?">${how(v)}</button></td>
      <td class="num ${t.amount > 0 ? 'in' : ''}">${t.amount > 0 ? '+' : ''}${money(Math.abs(t.amount))}</td>
    </tr>`
  }).join('') || '<tr><td colspan="4" class="empty">No lines match.</td></tr>'
  const more = $('more')
  more.hidden = rows.length <= s.shown
  more.textContent = `Show ${Math.min(100, rows.length - s.shown)} more`
}

let mounted = false
function mountOnce(): void {
  if (mounted) return
  mounted = true
  const examples = ['How much did I spend on coffee last month?', 'How many times did I use Uber?', 'What do my subscriptions cost?', 'How much went on food delivery since August?', 'What did getting around cost me?']
  $('ask').innerHTML = `
    <h2 id="ask-h">Ask your statement</h2>
    <p class="section-note">Plain questions. When the wording is not obvious, the model turns it into a query; the adding up is always done by the app, so the figure is exact.</p>
    <form id="ask-form" class="ask-form"><label class="sr" for="question">Your question</label><input id="question" type="text" autocomplete="off" placeholder="How much went on food delivery since August?" maxlength="160"><button class="btn primary" type="submit">Ask</button></form>
    <div class="examples">${examples.map(x => `<button type="button" class="example" data-act="example">${e(x)}</button>`).join('')}</div>
    <div id="answer" aria-live="polite"></div>`
  $('lines').innerHTML = `
    <h2 id="lines-h">Every line</h2>
    <div class="tools"><label class="sr" for="search">Search lines</label><input id="search" type="search" placeholder="Search merchant or description" autocomplete="off"><span id="filters" class="filters"></span><span id="line-count" class="line-count"></span></div>
    <div class="table-wrap"><table class="lines"><thead><tr><th scope="col">Date</th><th scope="col">Merchant</th><th scope="col">Category</th><th scope="col" class="num">Amount</th></tr></thead><tbody id="rows"></tbody></table></div>
    <button type="button" class="btn quiet" id="more" data-act="more" hidden>Show more</button>`
  $('search').addEventListener('input', event => {
    if (!state) return
    state.search = (event.target as HTMLInputElement).value
    state.shown = 60
    paintLines(state)
  })
  $('ask-form').addEventListener('submit', event => {
    event.preventDefault()
    void ask(($('question') as HTMLInputElement).value)
  })
}

// ---------------------------------------------------------------- actions

function toast(text: string): void {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout((toast as any).timer)
  ;(toast as any).timer = setTimeout(() => (el.hidden = true), 5200)
}

function whereLine(where: 'device' | 'cloud', ms: number): string {
  return where === 'device' ? `Written on this device in ${(ms / 1000).toFixed(1)} s. Nothing left your browser.` : `Written by Gemini in the cloud in ${(ms / 1000).toFixed(1)} s, after you allowed it. The text sent is in the ledger.`
}

function pick(ids: number[], label: string): void {
  if (!state) return
  state.picked = {ids: new Set(ids), label}
  state.onlyCategory = ''
  state.shown = 60
  paintLines(state)
  $('lines').scrollIntoView({behavior: 'smooth', block: 'start'})
}

function teach(merchant: string, to: CategoryId): void {
  if (!state) return
  classifier.teach(merchant, to)
  saveTaught()
  classifyAll(state)
  const own = state.imported.txns.filter(t => t.merchant === merchant)
  paint()
  toast(`Learned: ${own[0]?.label ?? merchant} is ${category(to).label}. ${plural(own.length, 'line')} updated. Saved on this device only.`)
}

let drafting: {alert: Alert; lines: Txn[]} | null = null
let draftRun = 0

async function writeDraft(): Promise<void> {
  if (!drafting) return
  const run = ++draftRun
  const area = $<HTMLTextAreaElement>('draft-text')
  const note = $('draft-where')
  area.value = ''
  area.readOnly = true
  note.textContent = 'Writing…'
  try {
    const task = draftTask(drafting.alert, drafting.lines, $<HTMLSelectElement>('draft-tone').value as Tone, $<HTMLSelectElement>('draft-to').value === 'bank')
    const reply = await runner.run(task, soFar => {
      if (run === draftRun) area.value = soFar
    })
    if (run !== draftRun) return
    area.value = reply.text.trim()
    note.textContent = whereLine(reply.where, reply.ms)
  } catch (err) {
    if (run !== draftRun) return
    note.textContent = reasonText(err)
  }
  area.readOnly = false
}

function openDraft(alert: Alert): void {
  if (!state) return
  drafting = {alert, lines: alert.txnIds.map(id => state!.imported.txns[id]!)}
  $('draft-h').textContent = alert.title
  $('draft-about').textContent = alert.detail
  $<HTMLSelectElement>('draft-to').value = alert.kind === 'fee' ? 'bank' : 'merchant'
  $<HTMLDialogElement>('draft').showModal()
  void writeDraft()
}

async function plainWords(s: State): Promise<void> {
  s.plain = {text: 'Writing…', note: ''}
  paint()
  try {
    const facts = summaryFacts({start: s.summary.startDay, end: s.summary.endDay, spent: s.summary.spent, cameIn: s.summary.cameIn, top: s.summary.byCategory.map(c => ({label: category(c.id).label, total: c.total})), regular: s.recurring, alerts: s.alerts, loose: looseChange(s.alerts)})
    const reply = await runner.run(summaryTask(facts), soFar => {
      const el = document.getElementById('plain-text')
      if (el && state === s) el.textContent = soFar
    })
    s.plain = {text: reply.text.trim(), note: whereLine(reply.where, reply.ms)}
  } catch (err) {
    s.plain = null
    toast(reasonText(err))
  }
  if (state === s) paint()
}

async function ask(question: string): Promise<void> {
  if (!state || !question.trim()) return
  const s = state
  const parsed = parseQuestion(question, s.summary.endDay)
  let target: Target | null = targetWithoutModel(parsed, s.imported.txns, s.recurring)
  let range = parsed
  let understood = target ? `${target.label} (read without the model)` : ''
  if (!target) {
    $('answer').innerHTML = '<div class="reply"><p class="reply-detail">Working out what you mean…</p></div>'
    try {
      const known = [...new Set(s.imported.txns.filter(t => t.amount < 0).map(t => t.merchant))]
      const reply = await runner.run(questionTask(question, s.summary.endDay, known))
      const q = readQuestion(reply.text, question, s.summary.endDay, known)
      if (q) {
        range = q.parsed
        const via = reply.where === 'device' ? 'the model on this device' : 'Gemini in the cloud, with your OK'
        if (q.about === 'category' && q.category) target = targetForCategory(q.category)
        else if (q.about === 'merchant') {
          const names = new Set(q.merchants)
          const labels = [...new Set(s.imported.txns.filter(t => names.has(t.merchant)).map(t => t.label))]
          target = {label: labels.slice(0, 3).join(', '), test: t => t.amount < 0 && names.has(t.merchant)}
        } else {
          const fixed = q.about === 'everything' || q.about === 'income' || q.about === 'fees' || q.about === 'subscriptions' ? q.about : null
          target = fixed ? targetWithoutModel({...q.parsed, fixed}, s.imported.txns, s.recurring) : null
        }
        if (target) understood = `${target.label} (worked out by ${via})`
      }
    } catch (err) {
      s.reply = {question, answer: {text: reasonText(err), detail: 'Try a merchant name (netflix) or a category (groceries); those need no model.', txnIds: []}, understood: 'not sent to the model'}
      paintReply(s)
      return
    }
  }
  if (!target) {
    s.reply = {question, answer: {text: 'I could not tell what that refers to in this statement.', detail: 'Try a merchant name (netflix), a category (groceries) or an idea (eating out, getting around).', txnIds: []}, understood: 'nothing matched'}
  } else {
    const a = answer(range, target, s.imported.txns, s.verdicts)
    const metric = {sum: 'total', count: 'count', average: 'average', biggest: 'biggest single line'}[range.metric]
    s.reply = {question, answer: a, understood: `${metric} · ${understood} · ${range.range ? range.range.label : 'whole statement'}`}
  }
  paintReply(s)
}

function showWhy(button: HTMLElement, t: Txn, v: Verdict): void {
  const el = $('why')
  let body = ''
  if (v.reason.how === 'known') body = `<p>The cleaned name <code>${e(t.merchant)}</code> matches the known merchant <b>${e(v.reason.example)}</b>, word for word. No model needed.</p>`
  else if (v.reason.how === 'rule') body = `<p>${e(v.reason.rule)}. Decided by a plain rule, no model needed.</p>`
  else if (v.reason.how === 'taught') body = `<p>You taught it: <b>${e(v.reason.example)}</b> is ${e(category(v.category).label)}. Saved on this device.</p>`
  else body = `<p>The model read <code>${e(t.merchant)}</code> ${v.reason.where === 'device' ? 'on this device' : 'in the cloud, after you allowed it'} and chose this category${v.reason.sure ? '' : ', marking it as a guess, so it asked you to check'}.</p>`
  el.innerHTML = `<h3>Why ${e(category(v.category).label)}?</h3>${body}<p id="explain-out" class="explain" aria-live="polite"></p><p class="row"><button type="button" class="link" data-act="explain" data-id="${t.id}">What is this charge?</button><button type="button" class="link" data-act="close-why">Close</button></p>`
  el.hidden = false
  const box = button.getBoundingClientRect()
  const width = Math.min(360, window.innerWidth - 24)
  el.style.width = `${width}px`
  el.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, box.left + window.scrollX - 40))}px`
  el.style.top = `${box.bottom + window.scrollY + 8}px`
}

async function explain(t: Txn): Promise<void> {
  const out = document.getElementById('explain-out')
  if (!out) return
  out.textContent = 'Asking the model. Only the merchant name is used, never the amount or date…'
  try {
    const reply = await runner.run(explainTask(t.merchant), soFar => (out.textContent = soFar))
    out.textContent = `${reply.text.trim()} (${reply.where === 'device' ? 'answered on this device' : 'answered in the cloud, with your OK'})`
  } catch (err) {
    out.textContent = reasonText(err)
  }
}

function exportCsv(s: State): void {
  const regular = new Map(s.recurring.map(r => [r.merchant, r.cadence]))
  const rows: (string | number)[][] = [['Date', 'Description', 'Merchant', 'Category', 'Amount', 'Decided by', 'Confidence', 'Regular']]
  for (const t of s.imported.txns) {
    const v = s.verdicts[t.id]!
    rows.push([isoDay(t.day), t.raw, t.label, category(v.category).label, (t.amount / 100).toFixed(2), v.reason.how, v.confidence.toFixed(2), regular.get(t.merchant) ?? ''])
  }
  const url = URL.createObjectURL(new Blob([toCsv(rows)], {type: 'text/csv'}))
  const a = document.createElement('a')
  a.href = url
  a.download = 'clawback-sorted.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

document.addEventListener('click', event => {
  const target = event.target as HTMLElement
  const closer = target.closest<HTMLElement>('[data-close]')
  if (closer) return void closer.closest('dialog')?.close()
  const el = target.closest<HTMLElement>('[data-act]')
  const why = $('why')
  if (!why.hidden && !target.closest('#why') && el?.dataset.act !== 'why') why.hidden = true
  if (!el) return
  const act = el.dataset.act
  const s = state
  if (act === 'close-why') return void (why.hidden = true)
  if (!s) return
  const i = Number(el.dataset.i)
  if (act === 'alert-lines') pick(s.alerts[i]!.txnIds, s.alerts[i]!.title)
  else if (act === 'draft') openDraft(s.alerts[i]!)
  else if (act === 'plain') void plainWords(s)
  else if (act === 'sort') void sortUnfamiliar(s)
  else if (act === 'regular-lines') pick(s.recurring[i]!.txnIds, s.recurring[i]!.label)
  else if (act === 'reply-lines' && s.reply) pick(s.reply.answer.txnIds, s.reply.question)
  else if (act === 'clear-picked') {
    s.picked = null
    paintLines(s)
  } else if (act === 'clear-category' || act === 'category') {
    const id = (el.dataset.category ?? '') as CategoryId | ''
    s.onlyCategory = act === 'clear-category' || s.onlyCategory === id ? '' : id
    s.picked = null
    s.shown = 60
    paintWhere(s)
    paintLines(s)
  } else if (act === 'more') {
    s.shown += 100
    paintLines(s)
  } else if (act === 'teach') teach(el.closest<HTMLElement>('[data-merchant]')!.dataset.merchant!, el.dataset.category as CategoryId)
  else if (act === 'example') {
    ;($('question') as HTMLInputElement).value = el.textContent ?? ''
    void ask(el.textContent ?? '')
  } else if (act === 'why') {
    const t = s.imported.txns[Number(el.dataset.id)]!
    showWhy(el, t, s.verdicts[t.id]!)
  } else if (act === 'explain') void explain(s.imported.txns[Number(el.dataset.id)]!)
  else if (act === 'export') exportCsv(s)
  else if (act === 'reset') {
    const forget = classifier.taught.length > 0 && confirm(`Also forget the ${plural(classifier.taught.length, 'correction')} you taught it on this device?`)
    if (forget) {
      classifier.taught = []
      saveTaught()
    }
    state = null
    $('app').hidden = true
    $('start').hidden = false
    ;($('file') as HTMLInputElement).value = ''
    window.scrollTo({top: 0})
  }
})

document.addEventListener('change', event => {
  const el = event.target as HTMLInputElement | HTMLSelectElement
  if (el.name === 'policy') {
    try {
      localStorage.setItem(POLICY_KEY, el.value)
    } catch {
      // The choice then lasts only for this visit.
    }
    paintAi()
    if (state) paint()
    return
  }
  if (el.id === 'draft-tone' || el.id === 'draft-to') return void writeDraft()
  const s = state
  if (!s) return
  if (el.dataset.act === 'drop') {
    const r = s.recurring[Number(el.dataset.i)]!
    if ((el as HTMLInputElement).checked) s.dropped.add(r.merchant)
    else s.dropped.delete(r.merchant)
    paint()
  } else if (el.dataset.act === 'recat') teach(s.imported.txns[Number(el.dataset.id)]!.merchant, el.value as CategoryId)
  else if (el.dataset.act === 'teach-select' && el.value) teach(el.closest<HTMLElement>('[data-merchant]')!.dataset.merchant!, el.value as CategoryId)
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('why').hidden = true
})

$('draft-again').addEventListener('click', () => void writeDraft())
$('draft-copy').addEventListener('click', async () => {
  const text = $<HTMLTextAreaElement>('draft-text').value
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied. Fill in your name and card digits before sending.')
  } catch {
    $<HTMLTextAreaElement>('draft-text').select()
    toast('Select all is done for you: press Ctrl or Cmd + C to copy.')
  }
})
$('ai-pill').addEventListener('click', () => {
  void refreshDevice()
  $<HTMLDialogElement>('ai-dialog').showModal()
})
$('ai-download-btn').addEventListener('click', async () => {
  const note = $('ai-download-progress')
  note.textContent = 'Starting the download…'
  try {
    await engine.prepareDevice(f => (note.textContent = `Downloading: ${Math.round(f * 100)}%`))
    note.textContent = 'Ready.'
  } catch (err) {
    console.error(err)
    note.textContent = 'Chrome could not download the model on this device.'
  }
  await refreshDevice()
  if (state && device === 'available') void sortUnfamiliar(state)
})

// ---------------------------------------------------------------- start page

async function readFile(file: File): Promise<void> {
  if (file.size > 20 * 1024 * 1024) {
    $('start-error').hidden = false
    $('start-error').textContent = 'That file is over 20 MB, which is more than a statement should be.'
    return
  }
  open(await file.text(), file.name)
}

const drop = $('drop')
const fileInput = $<HTMLInputElement>('file')
drop.addEventListener('click', () => fileInput.click())
drop.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    fileInput.click()
  }
})
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) void readFile(file)
})
window.addEventListener('dragover', event => {
  event.preventDefault()
  drop.classList.add('over')
})
window.addEventListener('dragleave', event => {
  if (!event.relatedTarget) drop.classList.remove('over')
})
window.addEventListener('drop', event => {
  event.preventDefault()
  drop.classList.remove('over')
  const file = event.dataTransfer?.files?.[0]
  if (file) void readFile(file)
})
$('try-sample').addEventListener('click', () => open(sampleStatement(), 'sample-statement.csv'))

void refreshDevice()

// A hook for the automated browser checks.
;(window as any).__clawback = {state: () => state, device: () => device, ledger: () => runner.ledger, engine: () => engine}

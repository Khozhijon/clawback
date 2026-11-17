import {CATEGORIES} from '../core/categories.ts'
import {formatDay, fromDay, monthIndex, monthLabel, monthStart} from '../core/dates.ts'
import {money} from '../core/money.ts'
import type {Parsed} from '../core/ask.ts'
import type {Alert, CategoryId, Day, Recurring, Txn} from '../core/types.ts'

/**
 * Everything the generative model is asked to do, as plain data: the instruction, the exact
 * text that would be sent, and (for structured answers) the shape of the reply.
 *
 * Keeping the prompts here, free of any SDK, means the consent dialog can show the user the
 * very same text the model receives, and the tests can check it without a model.
 */
export interface Task {
  /** Short name shown in the ledger and the consent dialog. */
  label: string
  system: string
  prompt: string
  /** JSON Schema of the reply, for structured tasks. */
  schema?: JsonSchema
  /** Upper bound on the reply, in tokens. */
  maxTokens: number
}

export type JsonSchema =
  | {type: 'object'; properties: Record<string, JsonSchema>; required?: string[]}
  | {type: 'array'; items: JsonSchema}
  | {type: 'string'; enum?: string[]}
  | {type: 'boolean'}
  | {type: 'integer'}

const SPENDING = CATEGORIES.filter(c => c.id !== 'income')
const CATEGORY_HINTS: Record<string, string> = {
  housing: 'rent, landlords, property managers, student housing, storage, movers',
  bills: 'electricity, gas, water, internet, mobile phone, insurance, laundry',
  groceries: 'supermarkets, food markets, butchers, corner stores, liquor stores',
  eating_out: 'restaurants, takeaway, food delivery, bars, fast food',
  coffee: 'coffee shops, cafes, bakeries, bubble tea, donuts, ice cream, snacks',
  transport: 'rides, taxis, transit, fuel, parking, tolls, car repair, bike share',
  travel: 'airlines, hotels, hostels, car rental, intercity trains and buses',
  subscriptions: 'streaming, software, cloud storage, news, apps, memberships',
  shopping: 'clothes, electronics, books, home goods, hardware, gifts, online marketplaces',
  health: 'pharmacies, doctors, dentists, opticians, gyms, hairdressers, therapy',
  education: 'tuition, bookstores, exams, courses, student loans, printing',
  fun: 'cinema, concerts, museums, games, bowling, theme parks',
  fees: 'charges made by the bank itself',
  cash: 'cash withdrawals',
  transfers: 'money sent to people, card payments, savings and brokerage transfers',
  other: 'nothing above fits',
}

/** Sorts merchants no rule could place. One request covers up to about twenty names. */
export function categoriseTask(merchants: string[]): Task {
  return {
    label: 'Sort unfamiliar merchants',
    system:
      'You sort merchant names from a bank statement into spending categories. Names are cut short and written the way banks write them. ' +
      'Give one answer for every name on the list, each starting with the name exactly as written. Set "sure" to false when the name does not tell you what the business sells.',
    prompt:
      `Categories:\n${SPENDING.map(c => `- ${c.id}: ${CATEGORY_HINTS[c.id]}`).join('\n')}\n\n` +
      `Merchants:\n${merchants.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
    // Each answer starts by repeating the name it is for (from this list only), so an answer can
    // never be pinned on the wrong merchant, however many the model returns.
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {name: {type: 'string', enum: merchants}, category: {type: 'string', enum: SPENDING.map(c => c.id)}, sure: {type: 'boolean'}},
        required: ['name', 'category', 'sure'],
      },
    },
    maxTokens: 300 + merchants.length * 60,
  }
}

/**
 * Reads the model's reply for `categoriseTask`: a list of {name, category, sure}. Answers are
 * matched by name, so a missing or extra answer cannot shift the others. A name that is not on
 * the list, or a category the app does not offer, is dropped, never guessed. The first answer
 * for a name wins.
 */
export function readCategories(reply: string, merchants: string[]): Map<string, {category: CategoryId; sure: boolean}> {
  const out = new Map<string, {category: CategoryId; sure: boolean}>()
  let rows: unknown
  try {
    rows = JSON.parse(reply)
  } catch {
    return out
  }
  if (!Array.isArray(rows)) return out
  const asked = new Set(merchants)
  const valid = new Set<string>(SPENDING.map(c => c.id))
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as {name?: unknown; category?: unknown; sure?: unknown}
    if (typeof r.name !== 'string' || !asked.has(r.name) || out.has(r.name)) continue
    if (typeof r.category !== 'string' || !valid.has(r.category)) continue
    out.set(r.name, {category: r.category as CategoryId, sure: r.sure !== false})
  }
  return out
}

export type Tone = 'polite' | 'firm'

const ASK: Record<Alert['kind'], string> = {
  duplicate: 'a refund of the second charge',
  price_rise: 'either the earlier price back or the cheapest plan that fits, and if neither is possible, cancellation',
  trial: 'cancellation of the paid plan and a refund of charges taken after the trial, because the trial rolled over without a clear reminder',
  fee: 'a refund of these fees as a courtesy and an account type that does not carry them',
  overlap: 'cancellation of this subscription from the next billing date',
  new_recurring: 'cancellation of this subscription from the next billing date',
  unusual: 'an explanation of this charge and a correction if it is a mistake',
}

/**
 * Drafts the message that asks for the money back. The facts come from the statement lines the
 * alert is built on; the model only puts them into words.
 */
export function draftTask(alert: Alert, lines: Txn[], tone: Tone, toBank: boolean): Task {
  const facts = lines
    .slice(-8)
    .map(t => `- ${formatDay(t.day)}: ${t.raw} ${money(Math.abs(t.amount))}`)
    .join('\n')
  return {
    label: `Draft a message: ${alert.title}`,
    system:
      'You write short, clear customer-service messages for a bank or card customer. Use only the facts given. Do not invent order numbers, names, dates or amounts. ' +
      'Leave [your name] and [last four digits of your card] as placeholders. No subject line, no markdown. Under 130 words.',
    prompt:
      `Write a ${tone === 'firm' ? 'firm but civil' : 'polite and friendly'} message to ${toBank ? 'my bank' : 'the merchant\'s customer support'}.\n` +
      `What happened: ${alert.title}. ${alert.detail}\n` +
      `Statement lines:\n${facts}\n` +
      `What I am asking for: ${ASK[alert.kind]}.`,
    maxTokens: 260,
  }
}

/** Explains an unfamiliar descriptor. Only the cleaned merchant name is sent, never amounts or dates. */
export function explainTask(merchant: string): Task {
  return {
    label: `Explain a charge: ${merchant}`,
    system: 'You explain names from bank statements in one or two plain sentences, with no lists and no markdown. If the name does not identify a business, say so and suggest how to find out. Never name a specific company with confidence you do not have.',
    prompt: `On a card statement, a line reads "${merchant}". What kind of business is this likely to be?`,
    maxTokens: 90,
  }
}

const PREFIXES: [RegExp, string][] = [
  [/^SQ ?\*/i, '"SQ" means the seller takes cards through Square, a payment service many small shops use.'],
  [/^TST ?\*/i, '"TST" means the seller takes cards through Toast, a payment service used by restaurants.'],
  [/^(PAYPAL|PP) ?\*/i, 'The line starts with PayPal, so it was paid through a PayPal account.'],
  [/^GOOGLE ?\*/i, '"GOOGLE *" means the charge was billed through a Google account, for example an app or a subscription.'],
  [/^APPLE\.COM\/BILL/i, '"APPLE.COM/BILL" means the charge was billed through an Apple account, for example an app or a subscription.'],
]

/**
 * What the payment prefix on a statement line means. This is looked up, not asked of the model:
 * a small model will happily invent a meaning for "SQ".
 */
export function prefixNote(raw: string): string | null {
  return PREFIXES.find(([re]) => re.test(raw.trim()))?.[1] ?? null
}

/** Turns a plain question into a query the app can compute itself. The model never does the sums. */
export function questionTask(question: string, endDay: Day, merchants: string[]): Task {
  return {
    label: 'Understand a question',
    system:
      'You translate a question about a bank statement into a query. You never answer the question yourself. ' +
      'Pick the closest category when the question is about a kind of spending, a merchant when it names or clearly means one from the list, "everything" for all spending.',
    prompt:
      `The statement ends on ${formatDay(endDay)}.\n` +
      `Categories: ${SPENDING.map(c => c.id).join(', ')}.\n` +
      `Merchants in the statement: ${merchants.slice(0, 80).join('; ')}.\n` +
      `Question: ${question}`,
    schema: {
      type: 'object',
      properties: {
        metric: {type: 'string', enum: ['sum', 'count', 'average', 'biggest']},
        about: {type: 'string', enum: ['category', 'merchant', 'everything', 'income', 'fees', 'subscriptions', 'unknown']},
        category: {type: 'string', enum: SPENDING.map(c => c.id)},
        merchants: {type: 'array', items: {type: 'string'}},
        period: {type: 'string', enum: ['whole_statement', 'this_month', 'last_month', 'named_month', 'last_n_months', 'last_n_days', 'since_month']},
        month: {type: 'integer'},
        n: {type: 'integer'},
      },
      required: ['metric', 'about', 'period'],
    },
    maxTokens: 120,
  }
}

export interface AiQuery {
  parsed: Parsed
  about: 'category' | 'merchant' | 'everything' | 'income' | 'fees' | 'subscriptions' | 'unknown'
  category?: CategoryId
  merchants: string[]
}

/** Reads the model's reply for `questionTask` and works out the date range locally. */
export function readQuestion(reply: string, question: string, endDay: Day, known: string[]): AiQuery | null {
  let q: any
  try {
    q = JSON.parse(reply)
  } catch {
    return null
  }
  if (!q || typeof q !== 'object') return null
  const metric = ['sum', 'count', 'average', 'biggest'].includes(q.metric) ? q.metric : 'sum'
  const about = ['category', 'merchant', 'everything', 'income', 'fees', 'subscriptions'].includes(q.about) ? q.about : 'unknown'
  const thisMonth = monthIndex(endDay)
  const n = Number.isInteger(q.n) && q.n > 0 && q.n < 400 ? q.n : 0
  const month = Number.isInteger(q.month) && q.month >= 1 && q.month <= 12 ? q.month : 0
  let range: Parsed['range'] = null
  const named = () => {
    let idx = fromDay(endDay).y * 12 + (month - 1)
    if (idx > thisMonth) idx -= 12
    return idx
  }
  if (q.period === 'this_month') range = {from: monthStart(thisMonth), to: endDay, label: monthLabel(thisMonth, true)}
  else if (q.period === 'last_month') range = {from: monthStart(thisMonth - 1), to: monthStart(thisMonth) - 1, label: monthLabel(thisMonth - 1, true)}
  else if (q.period === 'named_month' && month) range = {from: monthStart(named()), to: monthStart(named() + 1) - 1, label: monthLabel(named(), true)}
  else if (q.period === 'since_month' && month) range = {from: monthStart(named()), to: endDay, label: `since ${monthLabel(named(), true)}`}
  else if (q.period === 'last_n_months' && n) range = {from: monthStart(thisMonth - n + 1), to: endDay, label: `the last ${n} months`}
  else if (q.period === 'last_n_days' && n) range = {from: endDay - n + 1, to: endDay, label: `the last ${n} days`}
  const valid = new Set<string>(SPENDING.map(c => c.id))
  const category = typeof q.category === 'string' && valid.has(q.category) ? (q.category as CategoryId) : undefined
  // Only merchants that really are in the statement; the model is not allowed to add any.
  const merchants = Array.isArray(q.merchants) ? known.filter(k => q.merchants.some((m: unknown) => typeof m === 'string' && m.toLowerCase().trim() === k)) : []
  if (about === 'category' && !category) return null
  if (about === 'merchant' && !merchants.length) return null
  if (about === 'unknown') return null
  return {parsed: {metric, range, subject: question, fixed: null}, about, ...(category ? {category} : {}), merchants}
}

/** A short plain-language summary. Every number is computed by the app and handed over as a fact. */
export function summaryTask(facts: string[]): Task {
  return {
    label: 'Write a plain summary',
    system: 'You summarise a bank statement for its owner in four or five plain sentences. Use only the facts given and repeat amounts exactly as written. Never add up, combine or round amounts yourself. No advice about what to cancel, no markdown, no greeting.',
    prompt: `Facts:\n${facts.map(f => `- ${f}`).join('\n')}`,
    maxTokens: 220,
  }
}

/** The facts handed to `summaryTask`. */
export function summaryFacts(o: {start: Day; end: Day; spent: number; cameIn: number; top: {label: string; total: number}[]; regular: Recurring[]; alerts: Alert[]; loose: number}): string[] {
  const facts = [
    `Statement from ${formatDay(o.start)} to ${formatDay(o.end)}.`,
    `Money out ${money(o.spent)}, money in ${money(o.cameIn)}.`,
    `Largest spending categories: ${o.top.slice(0, 3).map(c => `${c.label} ${money(c.total)}`).join(', ')}.`,
    `${o.regular.filter(r => r.active).length} regular charges cost ${money(o.regular.filter(r => r.active && r.category !== 'transfers').reduce((s, r) => s + r.yearly, 0), true)} a year.`,
  ]
  for (const a of o.alerts.slice(0, 6)) {
    // A double charge is the easiest fact for a small model to garble, so it is spelled out.
    if (a.kind === 'duplicate') facts.push(`${a.title}: ${money(a.amount)} each time. One of the two charges looks like a mistake.`)
    else facts.push(`${a.title}: ${a.detail}`)
  }
  if (o.loose > 0) facts.push(`Fees, price rises and double charges add up to ${money(o.loose, true)} a year.`)
  return facts
}

/**
 * Dollar amounts in a model's reply that appear nowhere in the facts it was given.
 * The model words the summary; it is not allowed to produce a figure of its own.
 */
export function strayAmounts(reply: string, facts: string[]): string[] {
  const plain = (t: string) => t.replace(/,/g, '').replace(/\.00\b/g, '')
  const known = new Set((plain(facts.join(' ')).match(/\$\d+(?:\.\d+)?/g) ?? []))
  return [...new Set((plain(reply).match(/\$\d+(?:\.\d+)?/g) ?? []).filter(a => !known.has(a)))]
}

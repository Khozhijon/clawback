import {BANK, type BankEntry} from './bank.ts'
import type {CategoryId, Cents, Verdict} from './types.ts'

/** Rows whose confidence falls below this are put in front of the user for a look. */
export const REVIEW_BELOW = 0.5

export interface Taught {
  text: string
  category: CategoryId
}

/**
 * Wording banks use for their own charges. A bare "fee" is not enough: gyms, exam centres and
 * airlines all bill "fees", and those belong to the merchant's own category.
 */
const FEE = /\b(overdraft|nsf|insufficient funds|returned item|service charge|finance charge|interest charged?|(atm|maintenance|service|monthly|account|late|late payment|foreign transaction|intl transaction|international transaction|currency conversion|wire|wire transfer|annual|cash advance|paper statement|stop payment|transaction) fees?)\b/
const FEE_KINDS: [RegExp, string][] = [
  [/\bwire\b/, 'wire fee'],
  [/\batm\b/, 'ATM fee'],
  [/(foreign|intl|international|currency|fx|conversion)/, 'foreign transaction fee'],
  [/\b(overdraft|nsf|insufficient funds|returned item)\b/, 'overdraft fee'],
  [/\blate\b/, 'late fee'],
  [/(maintenance|monthly|service|account|statement)/, 'account fee'],
  [/(interest|finance)/, 'interest'],
]
const CASH = /\batm\b.*\b(withdraw\w*|w\/d|cash)\b|\bcash withdrawal\b|\b(withdraw\w*|w\/d)\b.*\batm\b/
const MONEY_IN_KINDS: [RegExp, string][] = [
  [/(refund|return|reversal|credit adj|chargeback|rebate)/, 'refund'],
  [/(payroll|salary|direct dep|paycheck|\badp\b|gusto|paychex|wages|stipend)/, 'pay'],
  [/(interest)/, 'interest'],
  [/(zelle|venmo|cash app|cashapp|paypal|transfer|xfer|wise|remitly)/, 'from people or other accounts'],
  [/(deposit)/, 'deposit'],
]

function tokens(text: string): string[] {
  return text.replace(/['.]/g, '').replace(/-/g, ' ').split(/\s+/).filter(Boolean)
}

interface Known {
  entry: BankEntry
  words: string[]
}

const KNOWN: Known[] = BANK.filter(e => e.match !== 'model').map(entry => ({entry, words: tokens(entry.text)}))

/**
 * Word-for-word lookup. Statement lines are often cut short ("blue bottle cof"), so the
 * final word of the line may be the start of the entry's final word.
 */
export function findKnown(merchant: string): BankEntry | null {
  const m = tokens(merchant)
  let best: Known | null = null
  for (const k of KNOWN) {
    const w = k.words
    if (k.entry.match === 'whole') {
      if (m.length === w.length && m.every((t, i) => t === w[i])) {
        if (!best || k.entry.text.length > best.entry.text.length) best = k
      }
      continue
    }
    for (let i = 0; i + w.length <= m.length; i++) {
      let ok = true
      for (let j = 0; j < w.length && ok; j++) {
        const mt = m[i + j]!
        const wt = w[j]!
        const lastOfLine = i + j === m.length - 1
        if (mt === wt) continue
        if (j === w.length - 1 && lastOfLine && w.length > 1 && mt.length >= 3 && wt.startsWith(mt)) continue
        ok = false
      }
      if (ok) {
        if (!best || k.entry.text.length > best.entry.text.length) best = k
        break
      }
    }
  }
  return best ? best.entry : null
}

/** Names to show for known merchants whose statement spelling is ugly. */
const PRETTY: Record<string, string> = {
  'amzn mktp': 'Amazon', amzn: 'Amazon', amazon: 'Amazon', wholefds: 'Whole Foods', nytimes: 'New York Times', openai: 'OpenAI',
  chatgpt: 'ChatGPT', 'mbta charlie': 'MBTA', mcdonalds: "McDonald's", 'apple bill': 'Apple services', 'uber trip': 'Uber',
  'lyft ride': 'Lyft', 'costco whse': 'Costco', disneyplus: 'Disney Plus', youtubepremium: 'YouTube Premium', icloud: 'iCloud',
  'hbo max': 'HBO Max', 'at&t': 'AT&T', 'pg&e': 'PG&E', cvs: 'CVS', 'h mart': 'H Mart', hmart: 'H Mart', tmobile: 'T-Mobile',
  ubereats: 'Uber Eats', 'trader joes': "Trader Joe's", wendys: "Wendy's", dominos: "Domino's", 'credit crd autopay': 'Credit card autopay',
  'online transfer to': 'Transfer to savings', 'steam games': 'Steam', steampowered: 'Steam', coned: 'Con Edison', github: 'GitHub',
  linkedin: 'LinkedIn', youtube: 'YouTube', paypal: 'PayPal', doordash: 'DoorDash', grubhub: 'Grubhub', jetblue: 'JetBlue',
  airbnb: 'Airbnb', ikea: 'IKEA', 'zoom us': 'Zoom', nordvpn: 'NordVPN', 'wal-mart': 'Walmart', cashapp: 'Cash App',
}

/**
 * The name to group and show a merchant by. A known merchant collapses to its listed name, so
 * "starbucks store" and "starbucks" are one merchant and every DoorDash order sits together.
 */
export function canonical(merchant: string): {merchant: string; label: string | null} {
  const known = findKnown(merchant)
  if (!known || known.category === 'fees' || known.category === 'income' || known.category === 'cash') return {merchant, label: null}
  const pretty = PRETTY[known.text]
  return {merchant: known.text, label: pretty ?? null}
}

/** The part of a verdict that needs no model: bank fees, cash, money in, known merchants. */
export function byRule(merchant: string, raw: string, amount: Cents): Verdict | null {
  const text = `${raw.toLowerCase()} ${merchant}`
  if (amount > 0) {
    const kind = MONEY_IN_KINDS.find(([re]) => re.test(text))?.[1] ?? 'other money in'
    return {category: 'income', confidence: 0.95, reason: {how: 'rule', rule: 'Money coming in'}, kind}
  }
  const known = findKnown(merchant)
  if (FEE.test(text) && (!known || known.category === 'fees')) {
    const kind = FEE_KINDS.find(([re]) => re.test(text))?.[1] ?? 'bank fee'
    return {category: 'fees', confidence: 0.97, reason: {how: 'rule', rule: `Wording of a bank charge (${kind})`}, kind}
  }
  if (CASH.test(text)) return {category: 'cash', confidence: 0.97, reason: {how: 'rule', rule: 'Cash withdrawal wording'}}
  if (known) {
    return {category: known.category, confidence: 0.97, reason: {how: 'known', example: known.text}, ...(known.kind ? {kind: known.kind} : {})}
  }
  return null
}

/** What the generative model said about a merchant no rule could place. */
export interface AiVerdict {
  category: CategoryId
  /** False when the model itself marked the answer as a guess. */
  sure: boolean
  where: 'device' | 'cloud'
}

export class Classifier {
  taught: Taught[] = []
  /** Answers from the generative model, by cleaned merchant name. */
  ai = new Map<string, AiVerdict>()

  /** Remembers a correction. It wins outright for that merchant. */
  teach(text: string, category: CategoryId): void {
    this.taught = this.taught.filter(t => t.text !== text)
    this.taught.push({text, category})
  }

  forget(text: string): void {
    this.taught = this.taught.filter(t => t.text !== text)
  }

  /** True when neither a correction, a rule nor a known name settles this merchant. */
  needsModel(merchant: string, raw: string, amount: Cents): boolean {
    return !this.taught.some(t => t.text === merchant) && !byRule(merchant, raw, amount) && !this.ai.has(merchant)
  }

  classify(merchant: string, raw: string, amount: Cents): Verdict {
    const exact = this.taught.find(t => t.text === merchant)
    if (exact) return {category: exact.category, confidence: 1, reason: {how: 'taught', example: exact.text, score: 1}}
    const rule = byRule(merchant, raw, amount)
    if (rule) return rule
    const ai = this.ai.get(merchant)
    if (ai) return {category: ai.category, confidence: ai.sure ? 0.8 : 0.35, reason: {how: 'ai', where: ai.where, sure: ai.sure}}
    return {category: 'other', confidence: 0, reason: {how: 'rule', rule: 'Not recognised yet'}}
  }
}

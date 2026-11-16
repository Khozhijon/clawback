import type {Engine, Reply, Where} from './engine.ts'
import type {Task} from './tasks.ts'

/**
 * How far the user lets their statement travel.
 *   device  never leaves this device; if the on-device model is missing, the feature waits
 *   ask     may use the cloud, but only after showing the exact text and getting a yes each time
 *   allow   may use the cloud without asking again (still recorded in the ledger)
 */
export type Policy = 'device' | 'ask' | 'allow'

export interface LedgerEntry {
  at: number
  label: string
  where: Where
  ms: number
  /** The exact text that left the device, or null when nothing did. */
  sent: string | null
}

export class Stopped extends Error {
  /** 'no-device': on-device model missing and the cloud is not allowed; 'declined': the user said no; 'no-cloud': no project configured. */
  reason: 'no-device' | 'declined' | 'no-cloud'
  constructor(reason: 'no-device' | 'declined' | 'no-cloud', message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Decides where each request runs. On this device whenever the built-in model is ready;
 * otherwise in the cloud only as far as the policy and the user's answer allow. Nothing is
 * sent anywhere without an entry in the ledger.
 */
export class Runner {
  ledger: LedgerEntry[] = []

  private engine: Engine
  private policy: () => Policy
  /** Shows the user the exact text and asks. Resolves true only on an explicit yes. */
  private consent: (task: Task) => Promise<boolean>
  private onLedger: () => void

  constructor(engine: Engine, policy: () => Policy, consent: (task: Task) => Promise<boolean>, onLedger: () => void = () => {}) {
    this.engine = engine
    this.policy = policy
    this.consent = consent
    this.onLedger = onLedger
  }

  async where(task: Task): Promise<Where> {
    if ((await this.engine.deviceState()) === 'available') return 'device'
    const policy = this.policy()
    if (policy === 'device') throw new Stopped('no-device', 'The on-device model is not ready, and you have chosen to keep everything on this device.')
    if (!this.engine.cloudConfigured()) throw new Stopped('no-cloud', 'The on-device model is not ready and no cloud service is set up.')
    if (policy === 'ask' && !(await this.consent(task))) throw new Stopped('declined', 'Nothing was sent.')
    return 'cloud'
  }

  async run(task: Task, onText?: (soFar: string) => void): Promise<Reply> {
    const where = await this.where(task)
    const reply = await this.engine.run(task, where, onText)
    this.ledger.push({at: Date.now(), label: task.label, where: reply.where, ms: reply.ms, sent: reply.where === 'cloud' ? `${task.system}\n\n${task.prompt}` : null})
    this.onLedger()
    return reply
  }

  /** How much text has left the device in this session. */
  sentChars(): number {
    return this.ledger.reduce((sum, e) => sum + (e.sent?.length ?? 0), 0)
  }
}

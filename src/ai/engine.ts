import {initializeApp, type FirebaseApp} from 'firebase/app'
import {initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider} from 'firebase/app-check'
import {getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type AI, type GenerativeModel} from 'firebase/ai'
import {CLOUD_MODEL, configured, firebaseConfig, RECAPTCHA_ENTERPRISE_SITE_KEY} from './config.ts'
import type {Task} from './tasks.ts'

/** Where a request is allowed to run. The caller decides; the engine never falls back on its own. */
export type Where = 'device' | 'cloud'
export type DeviceState = 'available' | 'downloadable' | 'downloading' | 'unavailable'

export interface Reply {
  text: string
  /** Where Firebase AI Logic reports the answer was produced. */
  where: Where
  ms: number
}

export interface Engine {
  /** Whether Chrome's built-in model can be used on this device right now. */
  deviceState(): Promise<DeviceState>
  /** Starts the on-device model download. Must be called from a click. */
  prepareDevice(onProgress: (fraction: number) => void): Promise<void>
  /** False when no Firebase project is configured, so nothing can be sent to the cloud. */
  cloudConfigured(): boolean
  run(task: Task, where: Where, onText?: (soFar: string) => void): Promise<Reply>
}

declare const LanguageModel: {availability(options?: unknown): Promise<string>} | undefined

const EXPECTED = {expectedInputs: [{type: 'text', languages: ['en']}], expectedOutputs: [{type: 'text', languages: ['en']}]}

/**
 * The real engine: every request goes through Firebase AI Logic. On-device requests use the
 * ONLY_ON_DEVICE mode (Gemini Nano in Chrome) and cloud requests use ONLY_IN_CLOUD, so the
 * mode is an explicit privacy decision made by the caller instead of a silent fallback.
 */
export class FirebaseEngine implements Engine {
  private app: FirebaseApp | null = null
  private ai: AI | null = null
  private models = new Map<string, GenerativeModel>()

  /** On a development machine, the debug token comes from the local server, never from the source. */
  private localToken: string | null = null

  async ready(): Promise<void> {
    if (this.localToken !== null || !configured) return
    this.localToken = ''
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return
    try {
      const res = await fetch('./__appcheck', {cache: 'no-store'})
      if (res.ok) this.localToken = (await res.text()).trim()
    } catch {
      // No local token: the debug provider will print a new one to register.
    }
  }

  private start(): AI {
    if (this.ai) return this.ai
    // On-device inference needs no network, but the SDK still wants an app to hang on to.
    this.app = initializeApp(configured ? firebaseConfig : {apiKey: 'not-configured', projectId: 'not-configured', appId: 'not-configured'})
    if (configured) {
      const debug = new URLSearchParams(location.search).get('appcheck')
      const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      if (debug) (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = debug === 'new' ? true : debug
      else if (local) (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = this.localToken || true
      initializeAppCheck(this.app, {
        // With a debug token set, the SDK uses it and never calls the provider.
        provider: RECAPTCHA_ENTERPRISE_SITE_KEY
          ? new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY)
          : new CustomProvider({getToken: () => Promise.reject(new Error('App Check has no provider for this address. Open the page with ?appcheck=new and register the token.'))}),
        isTokenAutoRefreshEnabled: true,
      })
    }
    this.ai = getAI(this.app, {backend: new GoogleAIBackend()})
    return this.ai
  }

  private model(task: Task, where: Where): GenerativeModel {
    const key = `${where}|${task.system}|${JSON.stringify(task.schema ?? null)}|${task.maxTokens}`
    let model = this.models.get(key)
    if (!model) {
      model = getGenerativeModel(this.start(), {
        mode: where === 'device' ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          model: CLOUD_MODEL,
          systemInstruction: task.system,
          generationConfig: {
            maxOutputTokens: task.maxTokens,
            temperature: task.schema ? 0 : 0.4,
            ...(task.schema ? {responseMimeType: 'application/json', responseSchema: ordered(task.schema) as any} : {}),
          },
        },
        onDeviceParams: {
          createOptions: {...EXPECTED, initialPrompts: [{role: 'system', content: task.system}]} as any,
          ...(task.schema ? {promptOptions: {responseConstraint: task.schema as any}} : {}),
        },
      })
      this.models.set(key, model)
    }
    return model
  }

  async deviceState(): Promise<DeviceState> {
    try {
      if (typeof LanguageModel === 'undefined') return 'unavailable'
      const state = await LanguageModel.availability(EXPECTED)
      return state === 'available' || state === 'downloadable' || state === 'downloading' ? state : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async prepareDevice(onProgress: (fraction: number) => void): Promise<void> {
    await this.ready()
    const model = getGenerativeModel(this.start(), {mode: InferenceMode.ONLY_ON_DEVICE, onDeviceParams: {createOptions: EXPECTED as any}})
    await model.initializeDeviceModel(onProgress)
  }

  /**
   * The cloud path needs App Check to vouch for the page: a debug token on a development machine
   * (or one passed with ?appcheck=), a reCAPTCHA Enterprise site key anywhere else. Without one,
   * a request would be refused, so the app says the cloud is not set up instead of asking for consent.
   */
  cloudConfigured(): boolean {
    if (!configured) return false
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    return local || RECAPTCHA_ENTERPRISE_SITE_KEY !== '' || new URLSearchParams(location.search).has('appcheck')
  }

  async run(task: Task, where: Where, onText?: (soFar: string) => void): Promise<Reply> {
    if (where === 'cloud' && !configured) throw new Error('No Firebase project is configured, so nothing can be sent to the cloud.')
    await this.ready()
    const started = performance.now()
    const model = this.model(task, where)
    if (onText) {
      const result = await model.generateContentStream(task.prompt)
      let text = ''
      for await (const chunk of result.stream) {
        text += chunk.text()
        onText(text)
      }
      const response = await result.response
      return {text: response.text() || text, where: source(response.inferenceSource, where), ms: Math.round(performance.now() - started)}
    }
    const result = await model.generateContent(task.prompt)
    return {text: result.response.text(), where: source(result.response.inferenceSource, where), ms: Math.round(performance.now() - started)}
  }
}

function source(reported: unknown, asked: Where): Where {
  if (reported === 'on_device') return 'device'
  if (reported === 'in_cloud') return 'cloud'
  return asked
}

/**
 * A stand-in used by the automated browser checks (`?ai=mock`), where Chrome has no built-in
 * model and no request may reach a real service. It answers from simple keyword rules so the
 * whole flow can be exercised: consent, streaming, the ledger, structured replies.
 */
export class MockEngine implements Engine {
  private device: DeviceState
  private cloud: boolean
  constructor(device: DeviceState, cloud: boolean) {
    this.device = device
    this.cloud = cloud
  }
  sent: {label: string; where: Where; prompt: string}[] = []

  async deviceState(): Promise<DeviceState> {
    return this.device
  }

  async prepareDevice(onProgress: (fraction: number) => void): Promise<void> {
    for (const f of [0.2, 0.6, 1]) {
      await new Promise(done => setTimeout(done, 60))
      onProgress(f)
    }
    this.device = 'available'
  }

  cloudConfigured(): boolean {
    return this.cloud
  }

  async run(task: Task, where: Where, onText?: (soFar: string) => void): Promise<Reply> {
    if (where === 'device' && this.device !== 'available') throw new Error('The on-device model is not ready.')
    if (where === 'cloud' && !this.cloud) throw new Error('No Firebase project is configured, so nothing can be sent to the cloud.')
    this.sent.push({label: task.label, where, prompt: task.prompt})
    const text = mockReply(task)
    if (onText) {
      const words = text.split(' ')
      for (let i = 4; i < words.length + 4; i += 4) {
        await new Promise(done => setTimeout(done, 12))
        onText(words.slice(0, i).join(' '))
      }
    }
    return {text, where, ms: 40}
  }
}

/** Gemini in the cloud writes properties in the order given by `propertyOrdering`; the on-device model follows the schema as written. */
function ordered(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(ordered)
  const s = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, ordered(sub)])) : k === 'items' ? ordered(v) : v
  if (s.type === 'object' && s.properties && typeof s.properties === 'object') out.propertyOrdering = Object.keys(s.properties)
  return out
}

function mockReply(task: Task): string {
  if (task.label.startsWith('Sort unfamiliar')) {
    const names = task.prompt.split('Merchants:\n')[1]!.split('\n').map(l => l.replace(/^\d+\. /, ''))
    const guess = (n: string): [string, boolean] => {
      if (/(pizza|taqueria|kitchen|noodle|casa|grill|tavern)/.test(n)) return ['eating_out', true]
      if (/(cafe|cup|donut|tea)/.test(n)) return ['coffee', !/cup/.test(n)]
      if (/(market|supermarket|produce|grocery)/.test(n)) return ['groceries', true]
      if (/(apartments|realty|housing)/.test(n)) return ['housing', true]
      if (/(airlines|hotel|inn)/.test(n)) return ['travel', true]
      if (/(dental|barber|hospital|clinic)/.test(n)) return ['health', true]
      if (/(bookstore|library|tuition|bursar)/.test(n)) return ['education', true]
      if (/(museum|theatre|games|bowling)/.test(n)) return ['fun', true]
      if (/(thrift|store|carpet|gift)/.test(n)) return ['shopping', true]
      return ['other', false]
    }
    return JSON.stringify(names.map(name => ({name, category: guess(name)[0], sure: guess(name)[1]})))
  }
  if (task.label === 'Understand a question') {
    const q = task.prompt.split('Question: ')[1]!.toLowerCase()
    if (/deliver/.test(q)) return JSON.stringify({metric: 'sum', about: 'merchant', merchants: ['doordash'], period: /august/.test(q) ? 'since_month' : 'whole_statement', month: 8})
    if (/around|rides/.test(q)) return JSON.stringify({metric: 'sum', about: 'category', category: 'transport', period: 'whole_statement'})
    return JSON.stringify({metric: 'sum', about: 'unknown', period: 'whole_statement'})
  }
  if (task.label.startsWith('Draft a message')) {
    const what = task.prompt.split('What happened: ')[1]!.split('\n')[0]!
    return `Hello, I am writing about a charge on my card ending [last four digits of your card]. ${what} Could you please look into this and put it right? Thank you, [your name]`
  }
  if (task.label.startsWith('Explain a charge')) return 'This looks like a small local business paid through a card reader. The name alone does not say what it sells, so check the date against what you bought that day.'
  return 'Over this statement you spent a little less than came in. Housing was the largest cost, followed by groceries and eating out. Several regular charges went up in price, and bank fees added up over the months.'
}

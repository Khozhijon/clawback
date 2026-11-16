import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MockEngine} from '../src/ai/engine.ts'
import {Runner, Stopped, type Policy} from '../src/ai/runner.ts'
import {categoriseTask, draftTask, explainTask, questionTask, readCategories, readQuestion, summaryFacts, summaryTask} from '../src/ai/tasks.ts'
import {findAlerts, looseChange} from '../src/core/alerts.ts'
import {Classifier} from '../src/core/classify.ts'
import {importStatement} from '../src/core/csv.ts'
import {toDay} from '../src/core/dates.ts'
import {findRecurring} from '../src/core/recurring.ts'
import {SAMPLE_END, sampleStatement} from '../src/core/sample.ts'
import {summarise} from '../src/core/summary.ts'

function sample() {
  const imported = importStatement(sampleStatement())
  const classifier = new Classifier()
  const verdicts = imported.txns.map(t => classifier.classify(t.merchant, t.raw, t.amount))
  const summary = summarise(imported.txns, verdicts)
  const recurring = findRecurring(imported.txns, verdicts, summary.endDay)
  const alerts = findAlerts(imported.txns, verdicts, recurring, summary.startDay, summary.endDay)
  return {imported, classifier, verdicts, summary, recurring, alerts}
}

test('categorise: the prompt lists every merchant and the reply is read strictly', () => {
  const names = ['golden dragon noodle house', 'thinking cup', 'cedar court apartments']
  const task = categoriseTask(names)
  for (const n of names) assert.ok(task.prompt.includes(n))
  assert.equal(task.schema?.type, 'array')
  const good = readCategories(JSON.stringify([{name: 'x', category: 'eating_out', sure: true}, {name: 'y', category: 'coffee', sure: false}, {name: 'z', category: 'housing', sure: true}]), names)
  assert.deepEqual(good.get('golden dragon noodle house'), {category: 'eating_out', sure: true})
  assert.deepEqual(good.get('thinking cup'), {category: 'coffee', sure: false})
  // A made-up category, a category the app never lets the model choose, and junk are all dropped.
  const bad = readCategories(JSON.stringify([{name: 'golden dragon noodle house', category: 'casino', sure: true}, {name: 'thinking cup', category: 'income', sure: true}, 'junk']), names)
  assert.equal(bad.size, 0)
  assert.equal(readCategories('not json', names).size, 0)
  assert.equal(readCategories('{"a":1}', names).size, 0)
  // Fewer rows than names: matched by name only, never by position.
  const partial = readCategories(JSON.stringify([{name: 'Thinking Cup', category: 'coffee', sure: true}]), names)
  assert.deepEqual([...partial.keys()], ['thinking cup'])
})

test('draft: only facts from the statement go into the prompt', () => {
  const {alerts, imported} = sample()
  const dup = alerts.find(a => a.kind === 'duplicate' && a.title.includes('La Casa'))!
  const lines = dup.txnIds.map(id => imported.txns[id]!)
  const task = draftTask(dup, lines, 'polite', false)
  assert.ok(task.prompt.includes('TST* LA CASA DE PEDRO WATERTOWN MA $38.40'))
  assert.ok(task.prompt.includes('a refund of the second charge'))
  assert.ok(task.prompt.includes("the merchant's customer support"))
  assert.ok(task.system.includes('[your name]'))
  const fee = alerts.find(a => a.kind === 'fee')!
  assert.ok(draftTask(fee, fee.txnIds.map(id => imported.txns[id]!), 'firm', true).prompt.includes('my bank'))
  // Never the whole statement: at most eight lines.
  const many = alerts.find(a => a.kind === 'overlap')!
  assert.ok(draftTask(many, many.txnIds.map(id => imported.txns[id]!), 'polite', false).prompt.split('\n- ').length <= 9)
})

test('explain: nothing but the merchant name leaves', () => {
  const task = explainTask('karakoy gulluoglu istanbul')
  assert.ok(task.prompt.includes('karakoy gulluoglu istanbul'))
  assert.ok(!/\$\d/.test(task.prompt), 'no amounts')
  assert.ok(!/20\d\d/.test(task.prompt), 'no dates')
})

test('question: the model picks the query, the app works out the dates and checks the merchants', () => {
  const known = ['doordash', 'uber trip', 'netflix']
  const task = questionTask('How much went on food delivery since August?', SAMPLE_END, known)
  assert.ok(task.prompt.includes('doordash; uber trip; netflix'))
  const q = readQuestion(JSON.stringify({metric: 'sum', about: 'merchant', merchants: ['DoorDash', 'grubhub'], period: 'since_month', month: 8}), 'q', SAMPLE_END, known)!
  assert.deepEqual(q.merchants, ['doordash'], 'a merchant that is not in the statement is ignored')
  assert.deepEqual(q.parsed.range, {from: toDay(2026, 8, 1), to: SAMPLE_END, label: 'since August 2026'})
  const cat = readQuestion(JSON.stringify({metric: 'count', about: 'category', category: 'transport', period: 'last_month'}), 'q', SAMPLE_END, known)!
  assert.equal(cat.category, 'transport')
  assert.equal(cat.parsed.metric, 'count')
  assert.equal(cat.parsed.range?.label, 'September 2026')
  assert.equal(readQuestion(JSON.stringify({metric: 'sum', about: 'category', category: 'casino', period: 'whole_statement'}), 'q', SAMPLE_END, known), null)
  assert.equal(readQuestion(JSON.stringify({metric: 'sum', about: 'merchant', merchants: ['nobody'], period: 'whole_statement'}), 'q', SAMPLE_END, known), null)
  assert.equal(readQuestion(JSON.stringify({metric: 'sum', about: 'unknown', period: 'whole_statement'}), 'q', SAMPLE_END, known), null)
  assert.equal(readQuestion('oops', 'q', SAMPLE_END, known), null)
  const month = readQuestion(JSON.stringify({metric: 'sum', about: 'everything', period: 'named_month', month: 12}), 'q', SAMPLE_END, known)!
  assert.equal(month.parsed.range?.label, 'December 2025', 'a month later than the statement means last year')
})

test('summary: the numbers are computed here and passed as facts', () => {
  const {summary, recurring, alerts} = sample()
  const facts = summaryFacts({start: summary.startDay, end: summary.endDay, spent: summary.spent, cameIn: summary.cameIn, top: [{label: 'Housing', total: 690000}], regular: recurring, alerts, loose: looseChange(alerts)})
  assert.ok(facts[0]!.includes('1 May 2026 to 31 Oct 2026'))
  assert.ok(facts.some(f => f.includes('Money out $15,031.36')))
  assert.ok(facts.some(f => f.includes('$791 a year')))
  assert.ok(summaryTask(facts).prompt.includes('Housing $6,900.00'))
})

function runner(device: 'available' | 'downloadable', cloud: boolean, policy: Policy, answer: boolean) {
  const engine = new MockEngine(device, cloud)
  const asked: string[] = []
  const r = new Runner(engine, () => policy, async task => {
    asked.push(task.label)
    return answer
  })
  return {engine, asked, r}
}

test('routing: on this device whenever the built-in model is ready, whatever the policy', async () => {
  for (const policy of ['device', 'ask', 'allow'] as Policy[]) {
    const {engine, asked, r} = runner('available', true, policy, false)
    const reply = await r.run(explainTask('thinking cup'))
    assert.equal(reply.where, 'device')
    assert.equal(asked.length, 0, 'no consent needed when nothing leaves')
    assert.equal(engine.sent[0]!.where, 'device')
    assert.equal(r.ledger[0]!.sent, null)
    assert.equal(r.sentChars(), 0)
  }
})

test('routing: without the on-device model, the policy decides', async () => {
  const strict = runner('downloadable', true, 'device', true)
  await assert.rejects(strict.r.run(explainTask('x')), (e: Stopped) => e.reason === 'no-device')
  assert.equal(strict.engine.sent.length, 0)

  const no = runner('downloadable', true, 'ask', false)
  await assert.rejects(no.r.run(explainTask('x')), (e: Stopped) => e.reason === 'declined')
  assert.equal(no.asked.length, 1)
  assert.equal(no.engine.sent.length, 0, 'a no means nothing is sent')
  assert.equal(no.r.ledger.length, 0)

  const yes = runner('downloadable', true, 'ask', true)
  const task = explainTask('thinking cup')
  const reply = await yes.r.run(task)
  assert.equal(reply.where, 'cloud')
  assert.equal(yes.r.ledger[0]!.sent, `${task.system}\n\n${task.prompt}`, 'the ledger keeps the exact text that left')
  assert.ok(yes.r.sentChars() > 50)

  const always = runner('downloadable', true, 'allow', false)
  assert.equal((await always.r.run(explainTask('x'))).where, 'cloud')
  assert.equal(always.asked.length, 0)

  const nowhere = runner('downloadable', false, 'allow', true)
  await assert.rejects(nowhere.r.run(explainTask('x')), (e: Stopped) => e.reason === 'no-cloud')
})

test('routing: streaming delivers the text as it grows', async () => {
  const {r} = runner('available', false, 'device', false)
  const {alerts, imported} = sample()
  const a = alerts[0]!
  const seen: string[] = []
  const reply = await r.run(draftTask(a, a.txnIds.map(id => imported.txns[id]!), 'polite', false), t => seen.push(t))
  assert.ok(seen.length > 2)
  assert.equal(seen[seen.length - 1], reply.text)
  assert.ok(seen.every((t, i) => i === 0 || t.length >= seen[i - 1]!.length))
})

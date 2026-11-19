// Records the demo video in the real Google Chrome, with the real models: Gemini Nano on the
// device and Gemini in the cloud, both through Firebase AI Logic. Nothing in it is a stand-in.
//
// It uses its own empty Chrome profile, so the video can show the whole story: no on-device model
// (the cloud asks for consent), the one-click download, then the same work done on the device.
//
//   npm run dev                      (in one terminal)
//   node tools/record-demo.cjs       (in another)  ->  submission/demo-1.webm, submission/demo-2.webm
//
// Captions are drawn by this script. To draw them it switches off the page's Content Security
// Policy for the recording; the app itself is unchanged.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0'
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {createRequire} = require('node:module')
let chromium
try {
  ;({chromium} = require('playwright'))
} catch {
  ;({chromium} = createRequire(path.join(__dirname, '..', '..', 'package.json'))('playwright'))
}

const base = process.env.BASE ?? 'http://localhost:5178/'
const out = path.join(__dirname, '..', 'submission')
const profile = process.env.PROFILE ?? path.join(os.homedir(), '.cache', 'clawback-demo-profile')
const size = {width: 1280, height: 720}
const pause = ms => new Promise(done => setTimeout(done, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function caption(page, text) {
  await page.evaluate(t => {
    let el = document.getElementById('demo-caption')
    if (!el) {
      el = document.createElement('div')
      el.id = 'demo-caption'
      el.setAttribute('popover', 'manual')
      el.style.cssText = 'position:fixed;inset:auto 0 0 0;margin:0;width:100%;max-width:none;box-sizing:border-box;border:0;padding:16px 40px;background:rgba(12,20,24,.94);color:#fff;font:600 23px/1.35 system-ui,sans-serif;text-align:center;'
      document.body.append(el)
    }
    el.textContent = t
    // Shown again each time so it stays above any dialog that has opened since.
    try { el.hidePopover() } catch {}
    el.showPopover()
  }, text)
}

async function smoothScroll(page, selector, offset = 110) {
  await page.evaluate(([sel, off]) => {
    const el = document.querySelector(sel)
    if (el) window.scrollTo({top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'smooth'})
  }, [selector, offset])
  await pause(1100)
}

const availability = page => page.evaluate(async () => {
  try {
    return await LanguageModel.availability({expectedInputs: [{type: 'text', languages: ['en']}], expectedOutputs: [{type: 'text', languages: ['en']}]})
  } catch (err) {
    return `error: ${err.message}`
  }
})

async function recordPage(context, name, play) {
  const page = await context.newPage()
  page.on('pageerror', err => log('page error:', err.message))
  try {
    await play(page)
  } finally {
    const video = page.video()
    await page.close()
    if (video && name) {
      const file = path.join(out, name)
      fs.rmSync(file, {force: true})
      await video.saveAs(file)
      log('saved', file)
    }
  }
}

;(async () => {
  fs.mkdirSync(out, {recursive: true})
  const tmp = path.join(out, 'video-tmp')
  fs.rmSync(tmp, {recursive: true, force: true})
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: size,
    recordVideo: {dir: tmp, size},
    bypassCSP: true,
    // Playwright's usual switches turn off the component updater and the optimisation guide, which
    // are what deliver Chrome's built-in model. So only the switches needed to drive Chrome are passed.
    ignoreDefaultArgs: true,
    args: ['--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', `--window-size=${size.width},${size.height + 90}`, 'about:blank'],
  })
  try {
    // ---- before: does this profile already have the model?
    let before = 'unknown'
    await recordPage(context, null, async page => {
      await page.goto(base)
      before = await availability(page)
    })
    log('on-device model at start:', before)

    if (before !== 'available') {
      // ---- part one: no on-device model, so the cloud asks first
      await recordPage(context, 'demo-1.webm', async page => {
        await page.goto(base)
        await page.waitForFunction(() => !/Checking/.test(document.getElementById('ai-pill-text').textContent))
        await caption(page, 'Clawback finds the money leaking from a bank statement, then writes the messages that get it back.')
        await pause(5000)
        await caption(page, 'A bank statement is private. So the AI runs on your device, and the cloud is used only if you agree.')
        await pause(5000)
        await page.click('#try-sample')
        await page.waitForSelector('#alerts .alert')
        await caption(page, 'A sample statement of 400 lines. Ordinary code, not AI, does the sums and finds the leaks.')
        await pause(4500)
        await smoothScroll(page, '#alerts')
        await caption(page, 'A meal charged twice, a $1 trial that became $22.99 a month, prices that crept up, bank fees.')
        await pause(5500)
        await caption(page, 'This Chrome has no on-device model yet. Drafting a refund message would need the cloud, so Clawback asks first.')
        await pause(1500)
        await page.click('#alerts .alert:first-child [data-act="draft"]')
        await page.waitForFunction(() => document.getElementById('consent').open)
        await caption(page, 'This is the complete text that would leave the device. Nothing is sent unless you press "Send it".')
        await pause(7000)
        await page.click('#consent-yes')
        await caption(page, 'Gemini in the cloud, through Firebase AI Logic (ONLY_IN_CLOUD), protected by App Check.')
        await page.waitForFunction(() => /cloud/.test(document.getElementById('draft-where').textContent), null, {timeout: 60000})
        await pause(5000)
        await page.click('#draft [data-close]')
        await page.click('#ai-pill')
        await page.waitForFunction(() => document.getElementById('ai-dialog').open)
        await caption(page, 'Every request is in the ledger: where it ran, and exactly what was sent.')
        await pause(2500)
        await page.locator('#ledger details summary').first().click().catch(() => {})
        await pause(4500)
        await page.evaluate(() => document.getElementById('ai-dialog').scrollTo({top: 0, behavior: 'smooth'}))
        await caption(page, 'One click downloads Gemini Nano into Chrome (initializeDeviceModel in Firebase AI Logic).')
        await pause(2500)
        await page.click('#ai-download-btn')
        await pause(9000)
        await caption(page, 'The download takes a minute or two. The video skips ahead to when it is ready.')
        await pause(4000)
      })

      // ---- off camera: wait for the download
      await recordPage(context, null, async page => {
        await page.goto(base)
        for (let i = 0; i < 360; i++) {
          const a = await availability(page)
          if (i % 6 === 0) log('waiting for the model:', a)
          if (a === 'available') return
          await pause(5000)
        }
        throw new Error('the on-device model did not become available within 30 minutes')
      })
    }

    // ---- part two: the same work on the device
    await recordPage(context, 'demo-2.webm', async page => {
      await page.goto(base)
      await page.waitForFunction(() => /on this device/.test(document.getElementById('ai-pill-text').textContent), null, {timeout: 60000})
      await caption(page, 'Gemini Nano is ready. From now on the AI runs on this device (ONLY_ON_DEVICE).')
      await pause(4500)
      await page.click('#try-sample')
      await page.waitForSelector('#alerts .alert')
      await caption(page, 'Twenty merchants no rule could place are being sorted by Gemini Nano, as JSON held to a schema.')
      await pause(4000)
      await smoothScroll(page, '#review', 200)
      await page.waitForFunction(() => document.getElementById('model-status').dataset.state !== 'busy', null, {timeout: 240000})
      await caption(page, 'Done: every merchant sorted on this device. Nothing was sent anywhere.')
      await pause(3500)
      await smoothScroll(page, '#alerts')
      await pause(1000)
      await page.click('#alerts .alert:first-child [data-act="draft"]')
      await caption(page, 'The same refund message, now written on the device. No consent dialog, because nothing leaves.')
      await page.waitForFunction(() => /on this device/.test(document.getElementById('draft-where').textContent), null, {timeout: 120000})
      await pause(6000)
      await page.selectOption('#draft-tone', 'firm')
      await caption(page, 'Firmer? Written to the bank instead? It is one click, and still on the device.')
      await page.click('#draft-again')
      await pause(1500)
      await page.waitForFunction(() => /on this device/.test(document.getElementById('draft-where').textContent), null, {timeout: 120000})
      await pause(5000)
      await page.click('#draft [data-close]')
      await smoothScroll(page, '#headline', 80)
      await caption(page, 'A summary in plain words. The model only words it: a reply with a figure the app did not supply is thrown away.')
      await page.click('[data-act="plain"]')
      await page.waitForFunction(() => /on this device/.test(document.getElementById('headline').textContent), null, {timeout: 120000})
      await pause(6500)
      await smoothScroll(page, '#ask')
      await caption(page, 'Questions in your own words: the model turns the question into a query, and the app does the sums.')
      await page.fill('#question', 'What did I blow on restaurants and takeout?')
      await pause(1200)
      await page.click('#ask-form button')
      await page.waitForFunction(() => /model on this device/.test(document.getElementById('ask').textContent), null, {timeout: 120000})
      await pause(6000)
      await page.click('#ai-pill')
      await page.waitForFunction(() => document.getElementById('ai-dialog').open)
      await caption(page, 'The ledger for this session: every request ran on this device. Nothing was sent.')
      await pause(6500)
      await page.click('#ai-dialog [data-close]')
      await page.evaluate(() => window.scrollTo({top: 0, behavior: 'smooth'}))
      await caption(page, 'Clawback: hybrid AI as a privacy switch. Built with Firebase AI Logic.  github.com/Khozhijon/clawback')
      await pause(6000)
    })
    log('RECORDED')
  } catch (err) {
    log('FAILED', err.stack ?? err)
    process.exitCode = 1
  } finally {
    await context.close()
    fs.rmSync(tmp, {recursive: true, force: true})
  }
})()

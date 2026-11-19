# Clawback

Finds the money leaking from your bank statement, then writes the messages that get it back.

Drop in a statement (a CSV from any bank). Clawback points out double charges, prices that went
up, trials that quietly became paid plans, overlapping subscriptions and bank fees, each with the
exact lines behind it. For every one of them a generative model drafts the refund or cancellation
message for you.

Built for the #BuildHybridAI hackathon. Every generative request goes through **Firebase AI Logic**.

## The idea: the inference mode is the privacy switch

A bank statement is about the most private text a person has. Hybrid inference lets the app
make a promise most AI finance tools cannot:

- **On this device first.** When Chrome's built-in Gemini Nano is ready, requests run with
  `InferenceMode.ONLY_ON_DEVICE`. Your statement lines are used by the model and go nowhere.
- **The cloud only by consent.** If the device has no built-in model, a request can go to Gemini
  with `InferenceMode.ONLY_IN_CLOUD`, but only after the app has shown you the complete text that
  would be sent and you have said yes. You can also choose "stay on this device" (never send) or
  "use the cloud without asking".
- **A ledger of everything.** Every request is listed with where it ran
  (`response.inferenceSource`) and, for cloud requests, the exact characters that left.
- **Never a silent fallback.** The app does not use `PREFER_*` modes for statement text, because a
  fallback the user did not see is exactly what this app exists to prevent.

## What the model does, and what it is not allowed to do

| Task | Sent to the model | Reply |
| --- | --- | --- |
| Draft a refund, cancellation or fee-waiver message | the alert and at most eight statement lines | streamed text |
| Sort merchants no rule could place | merchant names only, no amounts or dates | JSON, constrained by a schema; each answer repeats the name it is for |
| Understand a plain question | the question and the merchant names | JSON query; the app does the sums |
| Explain an unfamiliar charge | one merchant name | one or two sentences (what "SQ" or "TST" means is looked up, not asked) |
| Put the statement in plain words | figures the app has already computed | four or five sentences; a reply with a figure that was not given is thrown away |

The model never adds anything up. Totals, dates, regular charges and alerts come from ordinary,
tested code (`src/core`). Structured replies are checked strictly: an unknown category or a
merchant that is not in the statement is dropped, not trusted (`src/ai/tasks.ts`).

## How Firebase AI Logic is used

- `src/ai/engine.ts`: `getAI(app, {backend: new GoogleAIBackend()})` and `getGenerativeModel` with
  `mode`, `inCloudParams` (model, system instruction, JSON `responseSchema`) and `onDeviceParams`
  (`initialPrompts`, `responseConstraint`). `initializeDeviceModel()` is called from a button to
  download Gemini Nano. Streaming uses `generateContentStream`.
- `src/ai/runner.ts`: decides where each request runs from the device state and the person's
  choice, asks for consent, and keeps the ledger.
- `src/ai/tasks.ts`: every prompt as plain data, so the consent dialog shows the very text the
  model receives.
- **App Check** protects the cloud path: reCAPTCHA Enterprise on the live site, a debug token on a
  development machine. The page's Content Security Policy only allows
  connections to its own address and to Firebase.

## What testing with the real models changed

The first versions passed every automated check and still failed on real models. Three fixes came
out of running Gemini Nano in Chrome and Gemini in the cloud side by side:

- **Sorting.** Asked for a plain list of twelve answers, Gemini Nano often returned eleven or
  thirteen, and with numbered slots it pinned categories on the wrong merchants. Now every answer
  must begin with the merchant's name, chosen from the names that were asked, and answers are
  matched by name. Answers that are missing are asked again; nothing is guessed.
- **Summary.** Nano sometimes merged two figures into a new one. The app now compares every dollar
  amount in the reply with the facts it supplied, asks once more if one is new, and otherwise
  shows the facts as computed.
- **Explaining a charge.** Nano confidently invented a meaning for "SQ". Payment prefixes are now
  looked up in code and the model is only asked what kind of business the name suggests.

Measured on a MacBook Air (Apple silicon), Chrome 157, sample statement of 400 lines: a refund
message in about 6 s on the device and 2 s in the cloud; twenty unfamiliar merchants sorted in
about 25 s on the device; a question understood in 3 to 5 s on the device.

## Run it

Needs Node 22.18 or newer and desktop Chrome 139 or newer for the on-device model.

```bash
npm install
npm run dev        # builds and serves http://localhost:5178
```

Put your Firebase web config in `src/ai/config.ts`, turn on AI Logic with the Gemini Developer API
in the Firebase console, and register an App Check debug token for local use (open the page with
`?appcheck=new` and read the token from the console). Without a project the app still works with
the on-device model; the cloud choices are switched off.

```bash
npm test           # type check and 33 unit tests
npm run qa         # 8 end-to-end browser scenarios (needs "npm run dev" running and Playwright)
```

The browser checks use a stand-in engine (`?ai=mock`), because headless Chrome has no built-in
model and automated checks must not call a real service. It runs through the same routing,
consent, streaming and ledger code as the real engine.

## Limits

- CSV only; PDF statements are not read.
- The known-merchant list is mostly US names.
- The on-device model handles one request at a time and up to about 9,000 tokens, so merchants
  are sorted in batches of twelve.
- It adds up what the statement says and helps you write to whoever took the money. It does not
  give financial advice.

## How it was made

Built in November 2026 with help from Claude Code, an AI coding assistant. The statement reader,
the leak detection and the page layout come from my earlier project Loose Change (also built this
month); the Firebase AI Logic layer, the consent and ledger design, message drafting, and
model-based sorting and question reading are new here. The sample statement is invented.

Licensed under Apache-2.0.

# FirstRing on Vapi — build guide

The AI receptionist for GTA auto shops from the FirstRing runbook, built on **Twilio → Vapi → n8n → Google Calendar / Sheets**.
This replaces runbook phases 1–4 with something you provision in one command per shop.

```
Caller ─► shop's line (forwards) ─► Twilio number ─► Vapi assistant (one per shop, generated)
                                         │                   │ tool calls + end-of-call (X-Vapi-Secret, per shop)
                                         │                   ▼
                     SMS + voice fallback│            n8n: firstring-vapi ──► Google Calendar (book/move/cancel)
                    (X-Twilio-Signature) ▼                   │            └─► Google Sheet (calls / actions / sms)
                                  n8n: firstring-twilio-sms  │            └─► Twilio SMS (owner + customer)
                                  n8n: firstring-twilio-voice│
                                  n8n: firstring-hourly ─────┘  daily summary · minutes cap · 90-day purge
                                  n8n: firstring-errors  ──► ops sheet + SMS to Nion
```

```
firstring/
├── clients/example-autoshop.json   ← the 20-minute intake, as config (real clients are gitignored)
├── schema/client.schema.json       ← what a valid intake looks like
├── provision.mjs                   ← validate → Vapi assistant + number → Twilio webhooks → Sheet tabs → n8n
├── assistant/build.mjs             ← config → Vapi assistant (greeting, prompt, KB, tools)
├── lib/                            ← all business logic (tested in Node, bundled into n8n)
│   ├── scheduling.mjs  time.mjs    ← hours, durations, buffers, notice, max jobs/day, DST
│   ├── tools.mjs                   ← check / book / find / reschedule / cancel / escalate / message + owner YES/NO
│   ├── events.mjs                  ← end-of-call log + summary, text-back, SMS agent, carrier fallback
│   ├── jobs.mjs                    ← daily summary, retention purge
│   └── google.mjs twilio.mjs vapi.mjs llm.mjs prompt.mjs validate.mjs runtime.mjs
├── n8n/build.mjs  n8n/deploy.mjs   ← generate + upsert the 5 shared workflows
└── test/                           ← Node tests + a real-n8n end-to-end run
```

## 1. Where this deliberately differs from the runbook

| Runbook | Here | Why |
|---|---|---|
| One n8n workflow set per client (`firstring-<client>-`) | **Five shared workflows**; each shop's config is embedded at deploy | Copies drift. Rule #3 (no snowflakes) is easier to keep with one set. Adding a shop = one JSON file + one command. |
| Logic built from n8n nodes | Logic in `lib/` (plain JS), bundled into one Code node per workflow | Scheduling, double-booking and approvals need real tests. The same code runs in the tests and in n8n. |
| Vapi's native Google Calendar tool | Calendar through n8n | The native tool can't do durations, travel buffers, max jobs/day, double-booking checks or shadow-mode holds. |
| Transcripts/recordings in the Sheet | Sheet keeps **summary + call id only**; transcript stays in Vapi | Google Sheets version history keeps deleted rows, so a Sheet can't be reliably purged. The purge deletes the Vapi call record too. |
| `consent_verified` flag before recording | Disclosure in the first sentence of every call (`recording: true/false` per shop) | Consent happens in the greeting, so nothing can set the flag beforehand. A caller who objects is a `take_message`. |
| Rule #8 "Canadian data stays in Canada" | **Not achievable** with Twilio/Vapi/OpenAI/Google; PIPEDA doesn't require it | Replace it with: vendor agreements in place, and a privacy notice saying data may be processed in the US. |
| Shadow mode gates "every action" | Gates **bookings and reschedules**; cancellations are immediate | Your scenario 4 expects an immediate cancel with the slot released, and a cancel can't double-book anyone. |

## 2. One-time setup (Nion)

**Accounts:**
- **Twilio** (owns the numbers)
- **Vapi** (private API key)
- **OpenAI** (the SMS agent; Vapi bills voice LLM usage itself)
- **Google Cloud** service account with the Calendar + Sheets APIs enabled
- a self-hosted **n8n ≥ 2.x on Node 24**

**n8n environment:** everything below is required. The Code nodes read secrets from `$env`, matching runbook §2's environment-variable rule.

```
NODE_FUNCTION_ALLOW_BUILTIN=crypto         # JWT signing for Google, HMAC checks
N8N_BLOCK_ENV_ACCESS_IN_NODE=false         # Code nodes read the secrets below
EXECUTIONS_DATA_PRUNE=true                 # failed executions hold caller data …
EXECUTIONS_DATA_MAX_AGE=168                # … keep them 7 days max (hours)

FIRSTRING_WEBHOOK_BASE=https://n8n.yourdomain.ca   # exactly what Twilio/Vapi call (signatures depend on it)
FIRSTRING_MASTER_SECRET=<random 32+ bytes>         # per-shop Vapi secrets are derived from this
GOOGLE_SA_EMAIL=firstring@<project>.iam.gserviceaccount.com
GOOGLE_SA_KEY=<private_key from the JSON key, \n-escaped is fine>
TWILIO_ACCOUNT_SID=…  TWILIO_AUTH_TOKEN=…
OPENAI_API_KEY=…      VAPI_API_KEY=…                # Vapi key: purge deletes old call records
NION_ALERT_PHONE=+1…  FIRSTRING_OPS_SMS_FROM=+1…    # errors + minutes-cap alerts
FIRSTRING_OPS_SHEET_ID=…                           # sheet with an "errors" tab
```

**Provisioning machine:** use the same values plus `N8N_API_URL` and `N8N_API_KEY` (n8n → Settings → API). Rotate every key after the freelancer handover (runbook §2).

## 3. Onboarding a shop (after the 20-minute intake)

1. **Fill the config.** Copy `clients/example-autoshop.json` to `clients/<shop>.json` and fill it from the intake: services, prices, durations, hours, FAQs, policies, escalation topics, owner mobile and the shop's own number. Start with `"shadow_mode": true`. Keep real client files in a **private** repo; this one is public.
2. **Share Google access.** Share the shop's calendar ("Make changes to events") and a new Sheet with `GOOGLE_SA_EMAIL`, and put their ids in the config.
3. **Buy a Twilio number** (GTA area code) and put it in `phone.twilio_number`.
4. **Dry run:** `npm ci && node provision.mjs clients/<shop>.json`. It validates, prints the greeting, tools and plan, and touches nothing.
5. **Apply:** `node provision.mjs clients/<shop>.json --apply`. It:
   - checks Google access first, stopping before anything else if the calendar isn't shared
   - creates or updates the Vapi assistant
   - imports the number into Vapi with the owner's mobile as fallback
   - sets Twilio's SMS and voice-fallback webhooks
   - creates the Sheet tabs
   - redeploys the n8n workflows with every shop embedded

   Re-running updates the existing resources; it never duplicates them.
6. **Forward the shop's line.** The shop sets call forwarding on their existing line to the Twilio number. Make one test call and check the caller ID arrives as the caller, not the shop. If it shows the shop's number, use a different forwarding mode or carrier, or text-back won't work.
7. **Test.** Run the five scenarios in §5 on a real call, then 2 weeks in shadow mode.
8. **Go live.** Set `"shadow_mode": false` and run `--apply` again.

## 4. What the owner sees (put this in the handover doc)

- **During shadow mode:** "Booking request — Oil change, Tue Oct 13, 8:00 am, Sam (+1905…), Civic. Reply YES 4821 to confirm or NO 4821 to decline." **YES 4821** confirms and texts the customer. **NO 4821** frees the slot and tells the customer you'll call. **LIST** shows anything still pending. Approvals are only accepted from the owner's mobile.
- **After every call:** a one-line summary text. Urgent issues (complaints, damage claims, price disputes) arrive as an **URGENT** text straight away.
- **Daily at 6 PM:** calls answered, bookings, missed-call texts and replies, urgent issues, pending approvals, and minutes used against the cap.
- **Missed calls:** if a caller hangs up on the greeting, or the line falls back because Vapi is down and nobody answers, the caller gets a text from the shop name with "Reply STOP to opt out". The AI then carries on the conversation by text and can book. Callers aren't texted twice in 24 h, the shop's own numbers are never texted, and nobody is texted after STOP.

## 5. Five-scenario sign-off (runbook §7), as live calls

The backend side of each scenario is automated (`test/flows.test.mjs`). The voice side still needs a person calling, because only a real call shows what the model says.

| # | Say | Pass when |
|---|---|---|
| 1 | "Oil change, first available Tuesday." | Offers Tuesday's first open time; books it; event has name, vehicle, phone; owner texted |
| 2 | "How much for a tire swap?" then book | Says exactly the configured price, then books |
| 3 | Call back from the same phone: "Move my appointment to Thursday." | Finds it, offers Thursday, moves it; Tuesday is offered again afterwards |
| 4 | "Cancel my appointment." | Cancelled, owner texted, slot free |
| 5 | "Your guy scratched my rim." | Apologises, sends an URGENT text to the owner, books nothing, promises a callback. **Failing this fails the build.** |

Also try:
- calling from a withheld number
- hanging up during the greeting (you should get the text-back)
- texting "STOP"
- two phones booking the same slot at once (only one should get it)

## 6. Tests

```bash
npm ci && npm test                                  # 29 Node tests against mock Google/Twilio/OpenAI/Vapi/n8n APIs
N8N_BIN=/path/to/n8n node test/n8n-e2e.mjs          # boots real n8n, deploys the workflows, drives them over HTTP
```

**What was run before this was committed:**
- **Node suite: 29/29.** Covers:
  - scheduling: DST, notice, buffers, max jobs/day, all-day blocks, holidays
  - the five sign-off scenarios (backend side)
  - shadow mode: YES/NO/LIST, the reschedule swap, and an approval spoofed from a customer's phone
  - two callers booking one slot at once, with exactly one winning
  - a caller trying to touch someone else's booking
  - tier gating
  - text-back rules: 24 h dedupe, the shop's own number, STOP
  - the SMS agent booking with the texter's number, and the owner forward when the AI is down
  - the carrier fallback, the minutes-cap alerts, and the daily summary and 90-day purge
  - provisioning: idempotent, and it stops when Google isn't shared
  - a forged Vapi secret, another shop's secret, and a forged Twilio signature
- **Real n8n 2.42.6 on Node 24: 12/12.**
  - The 5 workflows were deployed through the n8n public API, and a redeploy updated them rather than duplicating.
  - Bad Vapi secret → 401; forged Twilio signature → 403.
  - Availability (80 ms round trip on localhost), a shadow-mode booking, and an owner "YES" by SMS all worked.
  - Find + cancel, complaint escalation, the hang-up text-back, and the voice-fallback TwiML all worked.
  - A thrown error reached `firstring-errors`, landing in the ops sheet and as an SMS with the phone number redacted.

**n8n Code-node sandbox rules** (both found by the real-n8n run and now covered by `test/sandbox.test.mjs`). Anyone editing `lib/` must keep to them:
- `Object.defineProperty` is a no-op inside Code nodes. That's why the bundle assigns a plain `FR = {...}` instead of using module exports.
- `URL`, `URLSearchParams`, `fetch` and `AbortSignal` don't exist there. Use `lib/encode.mjs`; HTTP goes through `this.helpers.httpRequest`.

**Not verified against live services:**
- **Vapi field names** (check against current docs):
  - `fallbackDestination` on phone numbers
  - the tool `server.secret` header
  - the `{{"now" | date: …}}` prompt template
  - `durationSeconds` and `artifact.messages` in end-of-call reports
- **Twilio** behaviour on a real Canadian number:
  - STOP handling
  - which caller ID arrives on forwarded calls
- **The voice model's real behaviour**, which only the §5 live calls can show.
- **Prices:** check current per-minute rates before quoting.

**n8n host notes:**
- n8n 2.x requires **Node ≥ 24**.
- If you install n8n with one Node version and run it on another, run `npm rebuild isolated-vm`, or n8n won't start.
- n8n's internal task broker uses port **5679**, so don't put n8n itself there.

## 7. Known limits

- **Pending holds don't expire.** A request the owner never answers keeps its slot. It shows in the daily summary and in LIST.
- **Reschedules outside shadow mode skip the race re-check that new bookings get.** Moving an existing booking only collides if two callers move into the same slot within the same second.
- **The SMS agent sees the last 12 messages** for that number. Older context is dropped.
- **One timezone per shop**, which is fine for the GTA.
- **French isn't supported.** English only, as the runbook scopes the pilot.

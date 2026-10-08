# The Athlete Market — Auto Follow-Up Agent

**One job: get more qualified parents on the phone with Chase.**

```
New landing-page lead → save → text them right away (with booking link)
→ follow up at ~24h and ~72h → stop the moment they reply, book, or opt out → notify Chase
```

It does **not** write AI replies to parents. It starts the conversation and hands it to Chase.

## How leads enter today (what was found)

Your Meta ads send families to the landing page (repo `Landing-Page-and-Submission-form`,
hosted on Netlify). The form saves each application to **Netlify Forms** (form name
`athlete-market`) and a **Google Sheet**. There was no backend, database, calendar or SMS tool,
and **the form had no SMS consent checkbox**. This system plugs into Netlify Forms with a signed
"outgoing webhook", so the landing page keeps working exactly as before.

## Architecture

```
Landing page form (existing Netlify site)
   │  Netlify Forms "outgoing webhook" (signed)
   ▼
/hooks/lead ───────────────┐        Netlify Functions (this repo, a separate Netlify site)
                           ▼
                     Supabase Postgres  ◄── leads, messages, audit trail, alerts
                           │
   scheduler (every 5 min) ┤── sends first text / follow-ups via Twilio (quiet hours, caps)
                           ▼
                      Twilio SMS ──► Parent ──► taps /r/<code> ──► Calendly (pre-filled)
                           │                                  │
   /hooks/twilio/inbound ◄─┘ replies, STOP                    │ booking / cancel / no-show
   /hooks/twilio/status  ◄── delivery receipts                ▼
                                                     /hooks/calendly
                           │
                           ▼
              Alerts to Chase (text to your cell + email) · /dashboard
```

| Piece | Choice | Why |
|---|---|---|
| Lead source | Netlify Forms outgoing webhook | Already where every lead lands; server-side and signed |
| Database | Supabase (Postgres) | Free tier, reliable, the stack you named |
| Backend | Netlify Functions + a scheduled function | You already host on Netlify; no servers to manage |
| SMS | Twilio (A2P 10DLC registered) | Most reliable US business texting, built-in STOP handling |
| Calendar | Calendly | Simplest for parents; has booking/cancel/no-show webhooks |
| Alerts | Text to your phone (Twilio) + email (Resend) | Fast and simple |

## Safety switch: `SMS_MODE`

| Mode | What happens |
|---|---|
| `dry_run` (default) | Nothing is sent. Messages are saved as "dry run" so you can see what *would* go out. |
| `test` | Only numbers in `SMS_TEST_ALLOWLIST` (your phone) get texts. |
| `live` | Real leads get texts. **Only switch to this after you approve go-live.** |

## What's built (each phase tested)

1. **New lead → text → calendar link.** Consent required; dedupe; quiet hours 8am–8pm in the parent's time zone.
2. **Booking detection.** Calendly booking marks the lead BOOKED, stops follow-ups, sends a confirmation, alerts you. Reschedules and cancellations handled.
3. **Follow-ups.** Follow-up #1 at ~24h, follow-up #2 at ~72h, then it stops for good.
4. **Replies + alerts.** Any reply stops automation and alerts you (🔥 for high-intent). STOP → DO_NOT_TEXT forever, with audit trail. Delivery failures alert you.
5. **Dashboard.** `/dashboard`: status counts, lead list, conversation view, reply box, mark showed/no-show/closed, funnel numbers.

## Run it

```bash
npm install
npm test        # 44 automated tests, in-memory database, no real texts
npm run demo    # local dashboard with sample data: http://localhost:8888/dashboard (password: demo)
```

Setup steps (accounts, keys, going live): **[docs/SETUP.md](docs/SETUP.md)**.

## Code map

| File | What it does |
|---|---|
| `src/leads.js` | Lead intake, consent evidence, dedupe, schedules the 3-text sequence |
| `src/sender.js` | The only place texts go out: all safety checks, retries, failure handling |
| `src/messages.js` | The exact approved texts (edit wording here) |
| `src/quietHours.js` | Recipient-local send window by state |
| `src/booking.js` | Calendly booked / rescheduled / canceled / no-show |
| `src/inbound.js` | Replies, STOP/START/HELP, high-intent flag, delivery receipts |
| `src/scheduler.js` | 5-minute job: due texts, stuck sends, "no leads lately" alert |
| `src/dashboard.js`, `src/metrics.js` | Dashboard + numbers |
| `src/security.js` | Webhook signature checks (Netlify, Twilio, Calendly), dashboard auth |
| `db/schema.sql` | Database tables |
| `docs/landing-page-sms-consent.patch` | Consent checkbox + Privacy/Terms pages for the landing page (not yet applied) |

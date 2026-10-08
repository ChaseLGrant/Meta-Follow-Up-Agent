# Setup guide (do these in order)

Nothing here texts a real parent until **step 9**, and step 9 needs your explicit go-ahead.
Put every key in **Netlify → Site configuration → Environment variables**. Never put keys in code.

---

## 1. Start Twilio registration FIRST (it takes days to weeks)

US carriers block business texts from unregistered numbers. Registration ("A2P 10DLC") is the slow part.

1. Create a Twilio account → upgrade it (add billing).
2. **Buy a local phone number** (a San Diego area code feels personal).
3. **Messaging → Services → Create Messaging Service** ("Athlete Market Follow-up"). Add the number to its Sender Pool.
4. **Messaging → Regulatory Compliance → A2P 10DLC → Register.**
   - Brand: "Low-Volume Standard" if you have an EIN; "Sole Proprietor" if you don't.
   - Campaign use case: **Mixed** (customer care + marketing). Paste these:
     - **Description:** "The Athlete Market texts parents of high school athletes who submit a recruiting application on our website and opt in to texts. Messages confirm we received their application, share a link to schedule a consultation call, follow up up to two times if they haven't booked, and confirm bookings."
     - **Opt-in description:** "Parents opt in by checking an unchecked SMS consent checkbox on our application form at [your landing page URL]. The checkbox text discloses message purpose, frequency, that msg & data rates may apply, HELP/STOP instructions, and links to our Privacy Policy and Terms. Consent is not required to submit the form."
     - **Sample messages:** copy the first text and follow-up #1 from `src/messages.js`.
     - **Privacy Policy / Terms URLs:** the pages from step 2 below (they must be live first).
5. **Messaging Service → Opt-out management (Advanced Opt-Out): turn it ON.**
   - STOP confirmation: "You're unsubscribed from The Athlete Market texts. No more messages will be sent."
   - HELP reply: "The Athlete Market: recruiting application updates. Help: [your email]. Msg & data rates may apply. Reply STOP to opt out."
6. **Messaging Service → Integration → Incoming messages → Send a webhook:**
   `https://<your follow-up site>/hooks/twilio/inbound` (fill in after step 5).
7. Keys you need: **Account SID**, **Auth Token**, **Messaging Service SID** (starts with `MG`).

> Faster alternative: a **toll-free number** with toll-free verification usually approves faster than 10DLC. It works with the same code; just add it to the Messaging Service.

## 2. Add the SMS consent checkbox to the landing page (required)

Without it, every lead is saved as "No SMS consent" and nobody gets texted.
`docs/landing-page-sms-consent.patch` adds the following to the `Landing-Page-and-Submission-form` repo:
- an **unchecked** consent checkbox under "Anything else we should know?",
- `privacy.html` and `terms.html` (fill in `[CONTACT EMAIL]`, `[BUSINESS ADDRESS]` and `[DATE]`; have a lawyer glance at them).

Apply it with `git apply docs/landing-page-sms-consent.patch` inside that repo, or ask me to open a PR there.
If you ever change the checkbox wording, bump `sms_consent_version` and add the new text to `CONSENT_TEXTS` in `src/leads.js`.

## 3. Calendly

1. Use (or create) a Calendly account on the **Standard plan or higher**. Webhooks require it.
2. Create the event "Recruiting Call" (15–20 min). Location: **Phone call — I will call my invitee**. Calendly then asks for their number.
3. Copy the event link → `CALENDLY_URL`.
4. **Integrations → API & Webhooks → Personal access token** → keep it for step 6.

## 4. Supabase (database)

1. Create a project at supabase.com (free tier is fine). Choose a US region.
2. **SQL Editor → New query** → paste all of `db/schema.sql` → **Run**.
3. **Project Settings → Database → Connection string → "Transaction pooler"** → copy it into `DATABASE_URL` (replace `[YOUR-PASSWORD]`).

## 5. Deploy this repo to Netlify (as a NEW site, separate from the landing page)

1. Netlify → **Add new site → Import from Git** → pick `Meta-Follow-Up-Agent`. No build settings needed (`netlify.toml` handles it).
2. **Environment variables:** copy everything from `.env.example`. Keep **`SMS_MODE=dry_run`**.
   - Generate long random strings for `NETLIFY_WEBHOOK_SECRET`, `LEAD_INTAKE_TOKEN`, `CALENDLY_WEBHOOK_SIGNING_KEY`, `DASHBOARD_PASSWORD` (e.g. `openssl rand -hex 24`).
   - Optional: a custom domain such as `follow-up.theathletemarket.com`. Texts carry this link, so your own domain looks more trustworthy than `*.netlify.app`. Set `PUBLIC_BASE_URL` to it.
3. Deploy. Open `https://<site>/dashboard`; it should ask for the password.

## 6. Connect the webhooks

- **Landing page site** (the existing one) → **Forms → Form notifications → Add notification → Outgoing webhook**
  - Event: New form submission · Form: `athlete-market`
  - URL: `https://<follow-up site>/hooks/lead`
  - JWS secret token: the same value as `NETLIFY_WEBHOOK_SECRET`
- **Twilio** incoming webhook: step 1.6.
- **Calendly**: run once on your computer:
  ```bash
  CALENDLY_TOKEN=... PUBLIC_BASE_URL=https://<follow-up site> CALENDLY_WEBHOOK_SIGNING_KEY=... \
    node scripts/create-calendly-webhook.js
  ```

## 7. Alerts to you

- `OWNER_PHONE`: your cell (+1 format). Alerts arrive as texts from your Twilio number.
- Email (optional): create a free **Resend** account, verify your domain, then set `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `OWNER_EMAIL`.

## 8. Test end to end with YOUR phone only

1. Set `SMS_MODE=test` and `SMS_TEST_ALLOWLIST=<your cell>`, then redeploy.
2. Send yourself a fake lead:
   ```bash
   PUBLIC_BASE_URL=https://<site> NETLIFY_WEBHOOK_SECRET=... node scripts/send-test-lead.js --phone "+1YOURCELL" --name Chase
   ```
3. Check: the first text arrives → it appears on the dashboard → tap the link → book a time → you get a confirmation text plus a "New call booked" alert → cancel in Calendly → you get a cancel alert.
4. Send another test lead with a different email, reply "how much does it cost?", and check you get a 🔥 alert.
5. Send another, reply **STOP**: no more texts, and the dashboard shows Opted out.
6. Submit the real landing page form with your own number and the box checked, to confirm the Netlify webhook works.

## 9. Go live (needs your approval)

Once Twilio registration is approved and step 8 passes, change `SMS_MODE=live` and redeploy.
To pause texting at any time, set `SMS_MODE=dry_run` and redeploy.

---

## Compliance built in

- Texts only go to leads who checked the consent box. The exact wording, time, IP, browser and page are saved as evidence.
- First text identifies you and the business, and includes "Reply STOP to opt out".
- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT and plain-English requests ("stop texting me", "wrong number", "remove me") all mark the lead DO_NOT_TEXT immediately. Every opt-out is in the audit trail.
- Quiet hours: texts go out only between 8am and 8pm in the parent's local time (from City/State). When a state spans two time zones, both must be inside the window.
- At most 3 automated texts per lead, plus one booking confirmation. Re-submitting the form never restarts the sequence.
- No AI writes to parents. Nothing makes claims about scholarships, outcomes, pricing or contracts.

This is good-faith engineering, not legal advice. Have a TCPA-aware attorney review the consent wording and Privacy/Terms pages.

## Rough monthly cost (check current pricing)

Twilio: about $1–2/mo for the number, a one-time brand and campaign registration fee, a monthly campaign fee, and roughly 1–3¢ per text including carrier fees. Calendly Standard: about $10–12/mo. Supabase and Netlify: free tiers are enough at this volume. Resend: free tier.

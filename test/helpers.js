import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/config.js';
import { signNetlify } from '../src/security.js';

process.env.NODE_ENV = 'test';
const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export const CHASE = '+17605550100';
export const BASE = 'https://follow-up.example.com';

// A full test world: in-memory Postgres, fake Twilio, fake email, controllable clock.
export async function makeWorld(envOverrides = {}) {
  const pg = new PGlite();
  await pg.exec(schema);
  const config = loadConfig({
    PUBLIC_BASE_URL: BASE,
    SMS_MODE: 'live',
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-secret', TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
    CALENDLY_URL: 'https://calendly.com/chase-tam/recruiting-call',
    CALENDLY_WEBHOOK_SIGNING_KEY: 'calendly-secret',
    NETLIFY_WEBHOOK_SECRET: 'netlify-secret',
    LEAD_INTAKE_TOKEN: 'intake-token',
    OWNER_PHONE: CHASE, OWNER_EMAIL: 'chase@example.com', RESEND_API_KEY: 're_test', ALERT_FROM_EMAIL: 'alerts@example.com',
    DASHBOARD_PASSWORD: 'dash-pass',
    ...envOverrides,
  });
  // 2026-10-06 is a Tuesday. 18:00Z = 11am Pacific / 2pm Eastern -> inside everyone's send window.
  let now = new Date('2026-10-06T18:00:00Z');
  const sent = [];
  const emails = [];
  let failNext = [];
  let sidCounter = 0;
  const world = {
    config,
    db: { query: (text, params) => pg.query(text, params) },
    now: () => new Date(now),
    sms: {
      async send({ to, body, statusCallback }) {
        if (failNext.length) throw failNext.shift();
        const sid = `SM${String(++sidCounter).padStart(32, '0')}`;
        sent.push({ to, body, statusCallback, sid, at: new Date(now) });
        return { sid, status: 'queued' };
      },
    },
    fetch: async (url, opts) => {
      emails.push({ url, ...JSON.parse(opts.body) });
      return new Response('{}', { status: 200 });
    },
    // test controls
    sent, emails,
    textsTo: (phone) => sent.filter((s) => s.to === phone),
    ownerTexts: () => sent.filter((s) => s.to === CHASE),
    setNow: (iso) => { now = new Date(iso); },
    advanceHours: (h) => { now = new Date(now.getTime() + h * 3600e3); },
    failSendsWith: (...errs) => { failNext = errs; },
    lead: async (id) => (await pg.query('select * from leads where id = $1', [id])).rows[0],
    leadByPhone: async (p) => (await pg.query('select * from leads where phone_e164 = $1', [p])).rows[0],
    messages: async (id) => (await pg.query('select * from messages where lead_id = $1 order by created_at, kind', [id])).rows,
    events: async (id) => (await pg.query('select type, detail from lead_events where lead_id = $1 order by id', [id])).rows,
    count: async (sql, params) => (await pg.query(sql, params)).rows[0].n,
  };
  return world;
}

let submissionCounter = 0;
export function netlifyPayload(overrides = {}) {
  submissionCounter++;
  return {
    id: `sub_${submissionCounter}_${Math.random().toString(36).slice(2, 8)}`,
    form_name: 'athlete-market',
    created_at: overrides.created_at || '2026-10-06T17:59:30Z',
    site_url: 'https://theathletemarket.com',
    data: {
      parent_first: 'Sarah', parent_last: 'Johnson', phone: '(760) 555-0123', email: 'Sarah.J@example.com',
      athlete_first: 'Jake', athlete_last: 'Johnson', sport: 'Baseball', grad_year: '2028',
      city_state: 'Carlsbad, CA', status: 'Contacted some coaches', timeline: 'Immediately',
      budget: 'Ready to invest', outcome: 'qualified_application', source: 'meta-ad-landing-v3',
      utm_source: 'facebook', utm_campaign: 'fall-parents', fbclid: 'fb.123',
      sms_consent: 'yes', sms_consent_version: 'v1', ip: '203.0.113.9', user_agent: 'Mozilla/5.0 (iPhone)',
      ...(overrides.data || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'data')),
  };
}

export function netlifyRequest(payload, secret = 'netlify-secret') {
  const raw = JSON.stringify(payload);
  return new Request(`${BASE}/hooks/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signNetlify(raw, secret) },
    body: raw,
  });
}

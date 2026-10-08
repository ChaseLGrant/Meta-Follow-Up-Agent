// Local demo: runs the whole system on your computer with a throwaway in-memory database,
// sample leads, and NO real texts (SMS_MODE=dry_run). Open http://localhost:8888/dashboard
// (username: anything, password: demo).
//
//   npm run demo
import http from 'node:http';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/config.js';
import { signNetlify } from '../src/security.js';
import { handleLeadWebhook } from '../src/handlers/leadWebhook.js';
import { handleLink } from '../src/handlers/link.js';
import { handleDashboard } from '../src/dashboard.js';
import { handleInboundSms } from '../src/inbound.js';
import { handleCalendlyEvent } from '../src/booking.js';
import { runScheduler } from '../src/scheduler.js';

process.env.QUIET_LOGS = '1';
const PORT = Number(process.env.PORT || 8888);
const BASE = `http://localhost:${PORT}`;

const pg = new PGlite();
await pg.exec(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
const config = loadConfig({
  PUBLIC_BASE_URL: BASE, SMS_MODE: 'dry_run', DASHBOARD_PASSWORD: 'demo', NETLIFY_WEBHOOK_SECRET: 'demo',
  CALENDLY_URL: 'https://calendly.com/your-link/recruiting-call', OWNER_TIMEZONE: 'America/Los_Angeles',
  SEND_WINDOW_START_HOUR: '0', SEND_WINDOW_END_HOUR: '24',
});
let clock = Date.now();
const deps = {
  config, db: { query: (t, p) => pg.query(t, p) }, now: () => new Date(clock),
  sms: { send: async () => ({ sid: 'demo' }) }, fetch: async () => new Response('{}'),
};

// ---- sample data
const families = [
  ['Sarah', 'Johnson', '760-555-0123', 'Jake', 'Baseball', '2028', 'Carlsbad, CA', 'yes'],
  ['Mike', 'Davis', '619-555-0144', 'Ava', 'Softball', '2027', 'San Diego, CA', 'yes'],
  ['Lauren', 'Kim', '512-555-0190', 'Ethan', 'Basketball', '2029', 'Austin, TX', 'yes'],
  ['Tony', 'Rivera', '305-555-0111', 'Mia', 'Volleyball', '2028', 'Miami, FL', 'yes'],
  ['Grace', 'Patel', '404-555-0177', '', 'Soccer', '2027', 'Atlanta, GA', 'yes'],
  ['Dan', 'Brooks', '303-555-0150', 'Cole', 'Football', '2028', 'Denver, CO', ''],
];
clock -= 4 * 86400e3;
for (const [i, f] of families.entries()) {
  clock += 9 * 3600e3;
  const payload = { id: `demo${i}`, created_at: new Date(clock).toISOString(), data: {
    parent_first: f[0], parent_last: f[1], phone: f[2], email: `${f[0].toLowerCase()}@example.com`,
    athlete_first: f[3], athlete_last: f[3] ? f[1] : '', sport: f[4], grad_year: f[5], city_state: f[6],
    outcome: 'qualified_application', sms_consent: f[7], sms_consent_version: 'v1', timeline: 'Within 30 days',
    budget: 'Want details first', status: 'Contacted some coaches', utm_campaign: 'fall-parents' } };
  const raw = JSON.stringify(payload);
  await handleLeadWebhook(deps, new Request(`${BASE}/hooks/lead`, { method: 'POST', headers: { 'x-webhook-signature': signNetlify(raw, 'demo') }, body: raw }));
}
const lead = async (p) => (await pg.query('select * from leads where phone_e164 = $1', [p])).rows[0];
clock += 3600e3;
await handleInboundSms(deps, { from: '+16195550144', body: 'Hi Chase! How much does the program cost? Could you call me tomorrow after 5?', sid: 'in1' });
const sarah = await lead('+17605550123');
await pg.query('update leads set link_clicks = 2, first_click_at = now() where id = $1', [sarah.id]);
await handleCalendlyEvent(deps, { event: 'invitee.created', payload: { uri: 'inv1', email: 'sarah@example.com',
  scheduled_event: { start_time: new Date(Date.now() + 86400e3).toISOString() }, tracking: { utm_content: sarah.link_code } } });
await handleInboundSms(deps, { from: '+13055550111', body: 'STOP', sid: 'in2' });
clock = Date.now();
await runScheduler(deps);

// ---- tiny server
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(BASE + req.url, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const path = new URL(request.url).pathname;
  let response;
  if (path === '/dashboard') response = await handleDashboard(deps, request);
  else if (path.startsWith('/r/')) response = await handleLink(deps, request, path.slice(3));
  else response = Response.redirect(`${BASE}/dashboard`, 302);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`Demo running: ${BASE}/dashboard  (password: demo)`));

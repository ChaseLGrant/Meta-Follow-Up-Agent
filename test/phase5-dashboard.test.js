// PHASE 5: dashboard + analytics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWorld, netlifyPayload, netlifyRequest, calendlyEvent, calendlyRequest, newInviteeUri, inboundSms, twilioRequest, BASE,
} from './helpers.js';
import { handleLeadWebhook } from '../src/handlers/leadWebhook.js';
import { handleCalendlyWebhook } from '../src/handlers/calendly.js';
import { handleTwilioInbound, handleTwilioStatus } from '../src/handlers/twilio.js';
import { handleLink } from '../src/handlers/link.js';
import { handleDashboard } from '../src/dashboard.js';
import { getMetrics } from '../src/metrics.js';

const auth = { Authorization: 'Basic ' + Buffer.from('chase:dash-pass').toString('base64') };
const get = (w, qs = '', headers = auth) => handleDashboard(w, new Request(`${BASE}/dashboard${qs}`, { headers }));
const post = (w, form, origin = BASE) => handleDashboard(w, new Request(`${BASE}/dashboard`, {
  method: 'POST', headers: { ...auth, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(form).toString(),
}));

// Five families: one books (+ shows + closes), one replies, one opts out, one no consent, one silent.
async function seed(w) {
  const add = (phone, email, data = {}) =>
    handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { phone, email, ...data } })));
  await add('760-555-0001', 'a@x.com', { parent_first: 'Amy', athlete_first: 'Ben' });
  await add('760-555-0002', 'b@x.com', { parent_first: 'Bo' });
  await add('760-555-0003', 'c@x.com', { parent_first: 'Cal' });
  await add('760-555-0004', 'd@x.com', { parent_first: 'Di', sms_consent: '' });
  await add('760-555-0005', 'e@x.com', { parent_first: 'Ed' });
  const amy = await w.leadByPhone('+17605550001');
  for (const s of w.sent.filter((x) => x.to !== '+17605550100')) {
    await handleTwilioStatus(w, twilioRequest('/hooks/twilio/status', { MessageSid: s.sid, MessageStatus: 'delivered' }));
  }
  await handleLink(w, new Request(`${BASE}/r/x`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } }), amy.link_code);
  const uri = newInviteeUri();
  await handleCalendlyWebhook(w, calendlyRequest(w, calendlyEvent('invitee.created', {
    uri, email: 'a@x.com', scheduled_event: { start_time: '2026-10-08T23:00:00Z' }, tracking: { utm_content: amy.link_code } })));
  await handleTwilioInbound(w, inboundSms('+17605550002', 'What does it cost?'));
  await handleTwilioInbound(w, inboundSms('+17605550003', 'STOP'));
  return { amy };
}

test('metrics: totals, response rate, clicks, lead->booked, show rate, closed', async () => {
  const w = await makeWorld();
  const { amy } = await seed(w);
  await post(w, { lead_id: amy.id, action: 'showed' });
  await post(w, { lead_id: amy.id, action: 'close_won' });
  const m = await getMetrics(w.db, new Date(0));
  assert.equal(m.total_leads, 5);
  assert.equal(m.texted, 4);
  assert.equal(m.texts_delivered, 4);
  assert.equal(m.replied, 1);
  assert.equal(m.response_rate, 25);
  assert.equal(m.clicked, 1);
  assert.equal(m.booked, 1);
  assert.equal(m.lead_to_booked_rate, 20);
  assert.equal(m.show_rate, 100);
  assert.equal(m.closed, 1);
  assert.deepEqual(m.by_status, { BOOKED: 1, REPLIED: 1, OPTED_OUT: 1, NO_CONSENT: 1, TEXT_SENT: 1 });
});

test('dashboard requires the password and locks out repeated wrong guesses', async () => {
  const w = await makeWorld();
  assert.equal((await get(w, '', {})).status, 401);
  const bad = { Authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') };
  for (let i = 0; i < 10; i++) assert.equal((await get(w, '', bad)).status, 401);
  assert.equal((await get(w, '', bad)).status, 429);
});

test('overview shows status cards, KPIs and every lead with the required columns', async () => {
  const w = await makeWorld();
  await seed(w);
  const res = await get(w);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const label of ['New leads', 'Text sent', 'Replied', 'Booked', 'No response', 'Opted out', 'Failed',
    'Lead → booked call', 'SMS response rate', 'Calendar link clicks', 'Show rate', 'Customers closed']) {
    assert.ok(html.includes(label), label);
  }
  for (const col of ['Name', 'Athlete', 'Sport', 'Grad', 'Received', 'Last message', 'Status', 'Booking', 'Appointment']) {
    assert.ok(html.includes(`<th>${col}</th>`), col);
  }
  assert.match(html, /What does it cost\?/);
  assert.match(html, /Oct 8, 4:00 PM/);
  const filtered = await (await get(w, '?status=REPLIED')).text();
  assert.match(filtered, />Bo Johnson</);
  assert.doesNotMatch(filtered, />Amy Johnson</);
});

test('lead page shows the conversation; manual reply sends from the business number', async () => {
  const w = await makeWorld();
  await seed(w);
  const bo = await w.leadByPhone('+17605550002');
  const html = await (await get(w, `?lead=${bo.id}`)).text();
  assert.match(html, /What does it cost\?/);
  assert.match(html, /Auto · first text/);
  const res = await post(w, { lead_id: bo.id, action: 'reply', body: 'Great question — can I give you a quick call at 5?' });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get('location')), /msg=Sent\./);
  assert.equal(w.textsTo('+17605550002').at(-1).body, 'Great question — can I give you a quick call at 5?');
});

test('manual replies are blocked for opted-out leads; cross-site posts are rejected', async () => {
  const w = await makeWorld();
  await seed(w);
  const cal = await w.leadByPhone('+17605550003');
  const before = w.sent.length;
  const res = await post(w, { lead_id: cal.id, action: 'reply', body: 'hi' });
  assert.match(decodeURIComponent(res.headers.get('location')), /opted out/);
  assert.equal(w.sent.length, before);
  assert.equal((await post(w, { lead_id: cal.id, action: 'close_won' }, 'https://evil.example')).status, 403);
});

test('user-submitted text is HTML-escaped', async () => {
  const w = await makeWorld();
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { parent_first: '<script>alert(1)</script>' } })));
  const html = await (await get(w)).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

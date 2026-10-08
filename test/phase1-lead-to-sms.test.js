// PHASE 1: new lead -> saved -> immediate SMS with booking link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, netlifyPayload, netlifyRequest, BASE } from './helpers.js';
import { handleLeadWebhook } from '../src/handlers/leadWebhook.js';
import { handleLink } from '../src/handlers/link.js';
import { SmsError } from '../src/sms.js';
import { processDueMessages } from '../src/sender.js';
import { initialText } from '../src/messages.js';

const SARAH = '+17605550123';

test('a consented lead is saved and texted immediately with the exact approved message', async () => {
  const w = await makeWorld();
  const res = await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.created, true);
  assert.equal(body.initial.sent, 'sent');

  const lead = await w.leadByPhone(SARAH);
  assert.equal(lead.status, 'TEXT_SENT');
  assert.equal(lead.email, 'sarah.j@example.com');
  assert.equal(lead.athlete_first, 'Jake');
  assert.deepEqual(lead.timezones, ['America/Los_Angeles']);
  assert.equal(lead.campaign.utm_campaign, 'fall-parents');
  assert.equal(lead.sms_consent_evidence.ip, '203.0.113.9');
  assert.match(lead.sms_consent_evidence.text, /Reply HELP for help, STOP to opt out/);

  const texts = w.textsTo(SARAH);
  assert.equal(texts.length, 1);
  const link = `${BASE}/r/${lead.link_code}`;
  assert.equal(texts[0].body, initialText({ parentFirst: 'Sarah', athleteFirst: 'Jake', link }));
  assert.match(texts[0].body, /^Hey Sarah — Chase here with The Athlete Market\.\n\nJust got the recruiting info you submitted for Jake\./);
  assert.match(texts[0].body, /Reply STOP to opt out\.$/);
  assert.equal(texts[0].statusCallback, `${BASE}/hooks/twilio/status`);

  // Follow-ups are queued (not sent) for +24h and +72h.
  const msgs = await w.messages(lead.id);
  const fu = Object.fromEntries(msgs.map((m) => [m.kind, m]));
  assert.equal(fu.fu1.status, 'scheduled');
  assert.equal(fu.fu2.status, 'scheduled');
  assert.equal(new Date(fu.fu1.scheduled_for).toISOString(), '2026-10-07T17:59:30.000Z');
  assert.equal(new Date(fu.fu2.scheduled_for).toISOString(), '2026-10-09T17:59:30.000Z');

  const types = (await w.events(lead.id)).map((e) => e.type);
  assert.deepEqual(types, ['lead_received', 'sms_consent_captured', 'sequence_scheduled', 'sms_sent']);
});

test('uses the no-athlete-name version when athlete name is missing', async () => {
  const w = await makeWorld();
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { athlete_first: '', athlete_last: '' } })));
  const [t] = w.textsTo(SARAH);
  assert.match(t.body, /Just got the recruiting information you submitted\.\n\nI'd love to hear a little more about where your athlete is at/);
});

test('no SMS consent -> lead saved, NOT texted, Chase alerted to call', async () => {
  const w = await makeWorld();
  const p = netlifyPayload({ data: { sms_consent: undefined } });
  delete p.data.sms_consent;
  const res = await (await handleLeadWebhook(w, netlifyRequest(p))).json();
  assert.equal(res.initial.skipped, 'no_sms_consent');
  const lead = await w.leadByPhone(SARAH);
  assert.equal(lead.status, 'NO_CONSENT');
  assert.equal(w.textsTo(SARAH).length, 0);
  assert.equal((await w.messages(lead.id)).length, 0);
  assert.equal(w.ownerTexts().length, 1);
  assert.match(w.ownerTexts()[0].body, /no SMS consent/);
});

test('duplicate submissions never restart the sequence', async () => {
  const w = await makeWorld();
  const p = netlifyPayload();
  await handleLeadWebhook(w, netlifyRequest(p));
  // exact same webhook delivered twice (provider retry)
  const replay = await (await handleLeadWebhook(w, netlifyRequest(p))).json();
  assert.equal(replay.replay, true);
  // same family fills the form again an hour later, phone formatted differently
  w.advanceHours(1);
  const again = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { phone: '760-555-0123' } })))).json();
  assert.equal(again.duplicate, true);

  assert.equal(await w.count('select count(*)::int n from leads'), 1);
  assert.equal(w.textsTo(SARAH).length, 1);
  const lead = await w.leadByPhone(SARAH);
  assert.equal(lead.submission_count, 2);
  assert.equal(await w.count(`select count(*)::int n from messages where lead_id = $1`, [lead.id]), 3);
});

test('simultaneous duplicate webhooks still produce one lead and one text', async () => {
  const w = await makeWorld();
  await Promise.all([1, 2, 3].map(() => handleLeadWebhook(w, netlifyRequest(netlifyPayload()))));
  assert.equal(await w.count('select count(*)::int n from leads'), 1);
  assert.equal(w.textsTo(SARAH).length, 1);
});

test('rejects unsigned or wrongly signed webhooks', async () => {
  const w = await makeWorld();
  const bad = await handleLeadWebhook(w, netlifyRequest(netlifyPayload(), 'wrong-secret'));
  assert.equal(bad.status, 401);
  const none = await handleLeadWebhook(w, new Request(`${BASE}/hooks/lead`, { method: 'POST', body: '{}' }));
  assert.equal(none.status, 401);
  assert.equal(await w.count('select count(*)::int n from leads'), 0);
});

test('ignores spam, free-resource and disqualified submissions', async () => {
  const w = await makeWorld();
  for (const outcome of ['spam_suspected', 'free_resource_signup', 'disqualified_free_only']) {
    const r = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { outcome } })))).json();
    assert.equal(r.ignored, `outcome:${outcome}`);
  }
  assert.equal(await w.count('select count(*)::int n from leads'), 0);
});

test('quiet hours: a 10pm lead is texted at 8am their time, not at night', async () => {
  const w = await makeWorld();
  w.setNow('2026-10-07T05:00:00Z'); // 10pm Pacific
  const r = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ created_at: '2026-10-07T04:59:00Z' })))).json();
  assert.equal(new Date(r.initial.deferredUntil).toISOString(), '2026-10-07T15:00:00.000Z'); // 8:00am PDT
  assert.equal(w.textsTo(SARAH).length, 0);

  w.setNow('2026-10-07T14:55:00Z'); await processDueMessages(w);
  assert.equal(w.textsTo(SARAH).length, 0);
  w.setNow('2026-10-07T15:00:00Z'); await processDueMessages(w);
  assert.equal(w.textsTo(SARAH).length, 1);
});

test('unknown location uses the window that is safe in every US zone', async () => {
  const w = await makeWorld();
  w.setNow('2026-10-06T14:00:00Z'); // 10am ET but 7am PT -> must wait
  const r = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { city_state: '' } })))).json();
  assert.ok(r.initial.deferredUntil);
  assert.equal(new Date(r.initial.deferredUntil).toISOString(), '2026-10-06T15:00:00.000Z'); // 8am PT = 11am ET
});

test('dry_run mode (the default) never calls Twilio', async () => {
  const w = await makeWorld({ SMS_MODE: 'dry_run' });
  const r = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload()))).json();
  assert.equal(r.initial.sent, 'simulated');
  assert.equal(w.sent.length, 0);
});

test('test mode only texts allowlisted numbers', async () => {
  const w = await makeWorld({ SMS_MODE: 'test', SMS_TEST_ALLOWLIST: '+17605559999' });
  const r = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload()))).json();
  assert.equal(r.initial.blocked, 'test_mode');
  assert.equal(w.textsTo(SARAH).length, 0);
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { phone: '760-555-9999', email: 'chase@x.com' } })));
  assert.equal(w.textsTo('+17605559999').length, 1);
});

test('transient Twilio failure retries later; permanent failure marks FAILED and alerts Chase', async () => {
  const w = await makeWorld();
  w.failSendsWith(new SmsError('Twilio down', { code: 500 }));
  const r = await (await handleLeadWebhook(w, netlifyRequest(netlifyPayload()))).json();
  assert.ok(r.initial.retryAt);
  w.advanceHours(0.05); await processDueMessages(w);
  assert.equal(w.textsTo(SARAH).length, 1);

  const w2 = await makeWorld();
  w2.failSendsWith(new SmsError('Invalid To number', { code: 21211, permanent: true }));
  await handleLeadWebhook(w2, netlifyRequest(netlifyPayload()));
  const lead = await w2.leadByPhone(SARAH);
  assert.equal(lead.status, 'FAILED');
  assert.match(w2.ownerTexts()[0].body, /Text to a lead failed/);
});

test('Twilio says number is unsubscribed (21610) -> marked opted out, nothing else sent', async () => {
  const w = await makeWorld();
  w.failSendsWith(new SmsError('unsubscribed', { code: 21610, permanent: true }));
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  const lead = await w.leadByPhone(SARAH);
  assert.equal(lead.status, 'OPTED_OUT');
  const msgs = await w.messages(lead.id);
  assert.ok(msgs.filter((m) => m.kind !== 'initial').every((m) => m.status === 'canceled'));
});

test('calendar short link counts human clicks and forwards to Calendly with tracking', async () => {
  const w = await makeWorld();
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  const lead = await w.leadByPhone(SARAH);
  const bot = await handleLink(w, new Request(`${BASE}/r/x`, { headers: { 'User-Agent': 'facebookexternalhit/1.1 Facebot Twitterbot/1.0' } }), lead.link_code);
  assert.equal(bot.status, 302);
  const res = await handleLink(w, new Request(`${BASE}/r/x`, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone)' } }), lead.link_code);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://calendly.com/chase-tam/recruiting-call');
  assert.equal(loc.searchParams.get('name'), 'Sarah Johnson');
  assert.equal(loc.searchParams.get('email'), 'sarah.j@example.com');
  assert.equal(loc.searchParams.get('utm_content'), lead.link_code);
  assert.equal((await w.lead(lead.id)).link_clicks, 1);
  const unknown = await handleLink(w, new Request(`${BASE}/r/zzz`), 'zzz');
  assert.equal(unknown.headers.get('location'), 'https://calendly.com/chase-tam/recruiting-call');
});

test('generic API source requires bearer token and explicit consent text', async () => {
  const w = await makeWorld();
  const body = { external_id: 'zap-1', parent_first: 'Mike', phone: '+1 (619) 555-0144', email: 'mike@example.com',
    city_state: 'San Diego, CA', sms_consent: true, sms_consent_text: 'I agree to receive texts...', lead_source: 'meta_lead_ad' };
  const req = (token) => new Request(`${BASE}/hooks/lead`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await handleLeadWebhook(w, req('nope'))).status, 401);
  const r = await (await handleLeadWebhook(w, req('intake-token'))).json();
  assert.equal(r.initial.sent, 'sent');
  assert.match(w.textsTo('+16195550144')[0].body, /^Hey Mike — /);
});

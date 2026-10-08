// PHASE 3: 24-hour and 72-hour follow-ups, then stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, netlifyPayload, netlifyRequest, BASE } from './helpers.js';
import { handleLeadWebhook } from '../src/handlers/leadWebhook.js';
import { runScheduler } from '../src/scheduler.js';
import { followUp1Text, followUp2Text } from '../src/messages.js';

const SARAH = '+17605550123';

// Simulate the 5-minute cron for `hours`.
async function runCron(w, hours) {
  for (let i = 0; i < (hours * 60) / 5; i++) {
    w.advanceHours(5 / 60);
    await runScheduler(w);
  }
}

test('no booking/no reply: follow-up #1 at ~24h, #2 at ~72h, then nothing more', async () => {
  const w = await makeWorld();
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  const lead = await w.leadByPhone(SARAH);
  const link = `${BASE}/r/${lead.link_code}`;

  await runCron(w, 23.5);
  assert.equal(w.textsTo(SARAH).length, 1, 'nothing before 24h');
  await runCron(w, 1);
  let texts = w.textsTo(SARAH);
  assert.equal(texts.length, 2);
  assert.equal(texts[1].body, followUp1Text({ parentFirst: 'Sarah', athleteFirst: 'Jake', link }));
  assert.match(texts[1].body, /^Hey Sarah — just wanted to make sure you got my message yesterday\.\n\nI'd be happy to take a look at where Jake is/);
  assert.equal((await w.lead(lead.id)).status, 'TEXT_SENT');

  await runCron(w, 48);
  texts = w.textsTo(SARAH);
  assert.equal(texts.length, 3);
  assert.equal(texts[2].body, followUp2Text({ parentFirst: 'Sarah', athleteFirst: 'Jake', link }));
  assert.match(texts[2].body, /follow up one last time about Jake's recruiting/);
  assert.match(texts[2].body, /If now isn't the right time, no problem\.$/);
  assert.equal((await w.lead(lead.id)).status, 'NO_RESPONSE');

  await runCron(w, 24 * 7);
  assert.equal(w.textsTo(SARAH).length, 3, 'sequence stops after follow-up #2');
});

test('"your athlete" wording when athlete name is unknown', async () => {
  const w = await makeWorld();
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { athlete_first: '' } })));
  await runCron(w, 73);
  const [, fu1, fu2] = w.textsTo(SARAH);
  assert.match(fu1.body, /where your athlete is in the recruiting process/);
  assert.match(fu2.body, /one last time about your athlete's recruiting/);
});

test('a follow-up that falls in quiet hours waits until 8am local', async () => {
  const w = await makeWorld();
  w.setNow('2026-10-06T15:00:00Z');
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ created_at: '2026-10-06T15:00:00Z',
    data: { city_state: 'Atlanta, GA', phone: '404-555-0188', email: 'ga@example.com' } })));
  // Force follow-up #1 to come due at 9pm Eastern (as if the lead arrived at 9pm the night before).
  const lead = await w.leadByPhone('+14045550188');
  const { db } = w;
  await db.query(`update messages set scheduled_for = '2026-10-08T01:00:00Z' where lead_id = $1 and kind = 'fu1'`, [lead.id]);
  w.setNow('2026-10-08T00:55:00Z');
  await runCron(w, 1);
  assert.equal(w.textsTo('+14045550188').length, 1, 'not sent at 9pm ET');
  const fu1 = (await w.messages(lead.id)).find((m) => m.kind === 'fu1');
  assert.equal(new Date(fu1.scheduled_for).toISOString(), '2026-10-08T12:00:00.000Z'); // 8:00am EDT
  w.setNow('2026-10-08T11:58:00Z');
  await runCron(w, 0.1);
  assert.equal(w.textsTo('+14045550188').length, 2);
});

test('a send that crashed mid-flight is never re-sent automatically; Chase is told', async () => {
  const w = await makeWorld();
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  const lead = await w.leadByPhone(SARAH);
  await w.db.query(`update messages set status = 'sending', claimed_at = $2 where lead_id = $1 and kind = 'fu1'`,
    [lead.id, w.now()]);
  await runCron(w, 0.5);
  const fu1 = (await w.messages(lead.id)).find((m) => m.kind === 'fu1');
  assert.equal(fu1.status, 'failed');
  assert.match(w.ownerTexts().at(-1).body, /may not have gone out/);
  await runCron(w, 30);
  assert.equal(w.textsTo(SARAH).length, 1);
});

test('Chase is alerted once when leads stop arriving', async () => {
  const w = await makeWorld({ LEAD_SILENCE_ALERT_HOURS: '48' });
  await runScheduler(w);
  assert.equal(w.ownerTexts().length, 0, 'no alert before any lead ever arrives');
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { sms_consent: '' } })));
  const baseline = w.ownerTexts().length;
  w.advanceHours(47); await runScheduler(w);
  assert.equal(w.ownerTexts().length, baseline);
  w.advanceHours(2); await runScheduler(w);
  w.advanceHours(5); await runScheduler(w);
  const alerts = w.ownerTexts().filter((t) => /No new leads/.test(t.body));
  assert.equal(alerts.length, 1);
});

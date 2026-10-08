// PHASE 2: detect calendar booking -> stop sequence, confirm, notify Chase; handle cancel/reschedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, netlifyPayload, netlifyRequest, calendlyEvent, calendlyRequest, newInviteeUri } from './helpers.js';
import { handleLeadWebhook } from '../src/handlers/leadWebhook.js';
import { handleCalendlyWebhook } from '../src/handlers/calendly.js';
import { processDueMessages } from '../src/sender.js';

const SARAH = '+17605550123';

async function leadThatGotFirstText(w) {
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  return w.leadByPhone(SARAH);
}

function booked(lead, { uri = newInviteeUri(), start = '2026-10-08T23:30:00Z', old = null, email = 'someone-else@example.com', utm = lead?.link_code } = {}) {
  return calendlyEvent('invitee.created', {
    uri, email, name: 'Sarah Johnson', first_name: 'Sarah', old_invitee: old, rescheduled: false,
    scheduled_event: { uri: uri.split('/invitees')[0], start_time: start },
    tracking: { utm_source: 'sms', utm_content: utm },
    reschedule_url: 'https://calendly.com/reschedulings/abc',
  });
}

test('booking via the texted link -> BOOKED, follow-ups stopped, confirmation sent, Chase notified', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  w.advanceHours(2);
  const res = await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead)));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.matched, true);

  const l = await w.lead(lead.id);
  assert.equal(l.status, 'BOOKED');
  assert.equal(l.booking_status, 'BOOKED');
  assert.equal(new Date(l.appointment_at).toISOString(), '2026-10-08T23:30:00.000Z');

  const msgs = await w.messages(lead.id);
  const byKind = Object.fromEntries(msgs.map((m) => [m.kind, m]));
  assert.equal(byKind.fu1.status, 'canceled');
  assert.equal(byKind.fu2.status, 'canceled');
  assert.equal(byKind.booking_confirm.status, 'sent');

  const texts = w.textsTo(SARAH);
  assert.equal(texts.length, 2);
  assert.equal(texts[1].body, "You're all set, Sarah — I've got you down for Thu, Oct 8, 4:30 PM PDT. Looking forward to talking. — Chase");
  assert.match(w.ownerTexts().at(-1).body, /New call booked!\nBooked for Thu, Oct 8, 4:30 PM PDT/);

  // 3 days later: no follow-ups go out.
  w.advanceHours(80); await processDueMessages(w);
  assert.equal(w.textsTo(SARAH).length, 2);
});

test('matches a booking by email when the tracking code is missing', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  const r = await (await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { utm: null, email: 'SARAH.J@example.com' })))).json();
  assert.equal(r.leadId, lead.id);
});

test('reschedule: updates time once, does not double count, notifies as reschedule', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  const first = newInviteeUri();
  await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { uri: first })));
  w.advanceHours(1);
  // Calendly sends "canceled (rescheduled: true)" for the old invitee + "created" for the new one.
  await handleCalendlyWebhook(w, calendlyRequest(w, calendlyEvent('invitee.canceled', { uri: first, rescheduled: true })));
  const second = newInviteeUri();
  const r = await (await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { uri: second, old: first, start: '2026-10-09T17:00:00Z', utm: null })))).json();
  assert.equal(r.rescheduled, true);
  const l = await w.lead(lead.id);
  assert.equal(l.status, 'BOOKED');
  assert.equal(l.rescheduled_count, 1);
  assert.equal(new Date(l.appointment_at).toISOString(), '2026-10-09T17:00:00.000Z');
  assert.match(w.textsTo(SARAH).at(-1).body, /^Got it, Sarah — you're now set for Fri, Oct 9, 10:00 AM PDT/);
  assert.match(w.ownerTexts().at(-1).body, /Call rescheduled/);
});

test('reschedule events arriving in the opposite order still end BOOKED', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  const first = newInviteeUri(), second = newInviteeUri();
  await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { uri: first })));
  await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { uri: second, old: first, utm: null })));
  await handleCalendlyWebhook(w, calendlyRequest(w, calendlyEvent('invitee.canceled', { uri: first, rescheduled: true })));
  assert.equal((await w.lead(lead.id)).booking_status, 'BOOKED');
});

test('cancellation -> booking CANCELED, Chase notified, automation does NOT restart', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  const uri = newInviteeUri();
  await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { uri })));
  await handleCalendlyWebhook(w, calendlyRequest(w, calendlyEvent('invitee.canceled', {
    uri, rescheduled: false, cancellation: { reason: 'Conflict with practice', canceler_type: 'invitee' } })));
  const l = await w.lead(lead.id);
  assert.equal(l.booking_status, 'CANCELED');
  assert.equal(l.appointment_at, null);
  assert.equal(l.status, 'TEXT_SENT');
  assert.match(w.ownerTexts().at(-1).body, /canceled — reason: "Conflict with practice"/);
  const before = w.textsTo(SARAH).length;
  w.advanceHours(100); await processDueMessages(w);
  assert.equal(w.textsTo(SARAH).length, before);
});

test('no-show marked in Calendly is recorded', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  const uri = newInviteeUri();
  await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead, { uri })));
  await handleCalendlyWebhook(w, calendlyRequest(w, calendlyEvent('invitee_no_show.created', { uri: 'https://api.calendly.com/invitee_no_shows/NS1', invitee: uri })));
  assert.equal((await w.lead(lead.id)).booking_status, 'NO_SHOW');
});

test('booking a call from someone who never filled the form creates a tracked lead but never texts them', async () => {
  const w = await makeWorld();
  const p = booked(null, { utm: null, email: 'walkin@example.com' });
  p.payload.text_reminder_number = '+1 858-555-0177';
  const r = await (await handleCalendlyWebhook(w, calendlyRequest(w, p))).json();
  assert.equal(r.matched, false);
  const l = await w.lead(r.leadId);
  assert.equal(l.lead_source, 'calendly_direct');
  assert.equal(l.status, 'BOOKED');
  assert.equal(w.textsTo('+18585550177').length, 0);
});

test('booking at 11pm their time: no late-night confirmation text (Calendly email covers it)', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  w.setNow('2026-10-07T06:00:00Z'); // 11pm PDT
  const r = await (await handleCalendlyWebhook(w, calendlyRequest(w, booked(lead)))).json();
  assert.match(r.confirmation.skipped, /quiet_hours/);
  assert.equal(w.textsTo(SARAH).length, 1);
});

test('rejects bad signatures and ignores duplicate deliveries', async () => {
  const w = await makeWorld();
  const lead = await leadThatGotFirstText(w);
  const evt = booked(lead);
  assert.equal((await handleCalendlyWebhook(w, calendlyRequest(w, evt, 'wrong'))).status, 401);
  await handleCalendlyWebhook(w, calendlyRequest(w, evt));
  const dup = await (await handleCalendlyWebhook(w, calendlyRequest(w, evt))).json();
  assert.equal(dup.duplicate, true);
  assert.equal(w.ownerTexts().filter((t) => /booked/.test(t.body)).length, 1);
});

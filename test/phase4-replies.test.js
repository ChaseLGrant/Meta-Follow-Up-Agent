// PHASE 4: inbound replies, opt-outs, delivery failures, notifications to Chase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, netlifyPayload, netlifyRequest, inboundSms, twilioRequest, CHASE } from './helpers.js';
import { handleLeadWebhook } from '../src/handlers/leadWebhook.js';
import { handleTwilioInbound, handleTwilioStatus } from '../src/handlers/twilio.js';
import { runScheduler } from '../src/scheduler.js';
import { classifyInbound } from '../src/inbound.js';

const SARAH = '+17605550123';

async function setup(env) {
  const w = await makeWorld(env);
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  return { w, lead: await w.leadByPhone(SARAH) };
}
async function cron(w, hours) {
  for (let i = 0; i < hours; i++) { w.advanceHours(1); await runScheduler(w); }
}

test('a real reply stops follow-ups, saves the conversation, and alerts Chase (no auto-reply)', async () => {
  const { w, lead } = await setup();
  w.advanceHours(3);
  const res = await handleTwilioInbound(w, inboundSms('+17605550123', 'Thanks! What does this usually involve?'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  const l = await w.lead(lead.id);
  assert.equal(l.status, 'REPLIED');
  assert.equal(l.last_message_direction, 'in');
  const msgs = await w.messages(lead.id);
  assert.ok(msgs.some((m) => m.direction === 'in' && m.body === 'Thanks! What does this usually involve?'));
  assert.ok(msgs.filter((m) => ['fu1', 'fu2'].includes(m.kind)).every((m) => m.status === 'canceled'));

  const alert = w.ownerTexts().at(-1);
  assert.equal(alert.to, CHASE);
  assert.match(alert.body, /New reply from a lead\n"Thanks! What does this usually involve\?"/);
  assert.match(alert.body, /Sarah Johnson — Jake Johnson · Baseball · '28/);
  assert.equal(w.emails.at(-1).to[0], 'chase@example.com');

  await cron(w, 80);
  assert.equal(w.textsTo(SARAH).length, 1, 'no automated follow-ups after a reply');
});

test('high-intent replies are flagged HOT', async () => {
  const { w } = await setup();
  await handleTwilioInbound(w, inboundSms(SARAH, 'Yes can you call me tomorrow around 5?'));
  assert.match(w.ownerTexts().at(-1).body, /🔥 HOT reply — call them now/);
});

test('classifier: opt-outs, opt-ins, help, intent', () => {
  for (const s of ['STOP', 'stop', 'Stop.', 'UNSUBSCRIBE', 'cancel', 'End', 'quit', 'STOPALL', 'Stop texting me please',
    'please do not text this number', 'Wrong number', 'remove me from your list', "don't message me again"]) {
    assert.equal(classifyInbound(s).kind, 'opt_out', s);
  }
  assert.equal(classifyInbound('Hi', 'STOP').kind, 'opt_out');
  assert.equal(classifyInbound('START').kind, 'opt_in');
  assert.equal(classifyInbound('help').kind, 'help');
  assert.equal(classifyInbound('Can I cancel and rebook for Friday?').kind, 'reply');
  assert.equal(classifyInbound('How much does it cost?').highIntent, true);
  assert.equal(classifyInbound('ok thanks').highIntent, false);
});

test('STOP -> DO_NOT_TEXT immediately, all future automation blocked, audit trail kept', async () => {
  const { w, lead } = await setup();
  await handleTwilioInbound(w, inboundSms(SARAH, 'STOP', { OptOutType: 'STOP' }));
  const l = await w.lead(lead.id);
  assert.equal(l.status, 'OPTED_OUT');
  assert.equal(l.do_not_text, true);
  assert.ok(l.opted_out_at);
  const events = await w.events(lead.id);
  const optOut = events.find((e) => e.type === 'opted_out');
  assert.equal(optOut.detail.reason, 'inbound_keyword');
  assert.deepEqual(optOut.detail.canceled.sort(), ['fu1', 'fu2']);

  await cron(w, 80);
  assert.equal(w.textsTo(SARAH).length, 1);
  // Submitting the form again does not restart texting.
  await handleLeadWebhook(w, netlifyRequest(netlifyPayload()));
  await cron(w, 80);
  assert.equal(w.textsTo(SARAH).length, 1);
});

test('START re-subscribes but does not restart the automation; Chase is told', async () => {
  const { w, lead } = await setup();
  await handleTwilioInbound(w, inboundSms(SARAH, 'STOP'));
  await handleTwilioInbound(w, inboundSms(SARAH, 'START', { OptOutType: 'START' }));
  const l = await w.lead(lead.id);
  assert.equal(l.do_not_text, false);
  assert.match(w.ownerTexts().at(-1).body, /re-subscribed/);
  await cron(w, 80);
  assert.equal(w.textsTo(SARAH).length, 1);
});

test('duplicate Twilio webhook deliveries are processed once', async () => {
  const { w } = await setup();
  const req1 = inboundSms(SARAH, 'Call me');
  const body = await req1.clone().text();
  const sig = req1.headers.get('x-twilio-signature');
  await handleTwilioInbound(w, req1);
  await handleTwilioInbound(w, new Request(req1.url, { method: 'POST', headers: { 'X-Twilio-Signature': sig }, body }));
  assert.equal(w.ownerTexts().filter((t) => /HOT/.test(t.body)).length, 1);
});

test('forged inbound webhooks are rejected', async () => {
  const { w, lead } = await setup();
  const res = await handleTwilioInbound(w, twilioRequest('/hooks/twilio/inbound', { MessageSid: 'x', From: SARAH, Body: 'STOP' }, 'not-the-token'));
  assert.equal(res.status, 403);
  assert.equal((await w.lead(lead.id)).do_not_text, false);
});

test('texts from unknown numbers are forwarded to Chase', async () => {
  const { w } = await setup();
  await handleTwilioInbound(w, inboundSms('+13105550111', 'Hi is this Chase?'));
  assert.match(w.ownerTexts().at(-1).body, /unknown number[\s\S]*Hi is this Chase\?/);
});

test('delivery receipts: delivered recorded; undelivered marks FAILED and alerts Chase; repeated failures alert once', async () => {
  const { w, lead } = await setup({ FAILURE_ALERT_THRESHOLD: '3' });
  const sid = w.textsTo(SARAH)[0].sid;
  await handleTwilioStatus(w, twilioRequest('/hooks/twilio/status', { MessageSid: sid, MessageStatus: 'delivered' }));
  assert.ok((await w.lead(lead.id)).first_delivered_at);
  // late/out-of-order "sent" receipt must not downgrade
  await handleTwilioStatus(w, twilioRequest('/hooks/twilio/status', { MessageSid: sid, MessageStatus: 'sent' }));
  assert.equal((await w.messages(lead.id)).find((m) => m.kind === 'initial').status, 'delivered');

  // three other leads whose texts bounce
  for (const [i, ph] of ['619-555-0101', '619-555-0102', '619-555-0103'].entries()) {
    await handleLeadWebhook(w, netlifyRequest(netlifyPayload({ data: { phone: ph, email: `p${i}@x.com` } })));
    const s = w.sent.at(-1).sid;
    await handleTwilioStatus(w, twilioRequest('/hooks/twilio/status', { MessageSid: s, MessageStatus: 'undelivered', ErrorCode: '30007' }));
  }
  const failedLead = await w.leadByPhone('+16195550101');
  assert.equal(failedLead.status, 'FAILED');
  const alerts = w.ownerTexts().map((t) => t.body);
  assert.equal(alerts.filter((b) => /was not delivered/.test(b)).length, 3);
  assert.equal(alerts.filter((b) => /3 texts failed in the last 6 hours/.test(b)).length, 1);
  assert.ok(alerts.some((b) => /30007/.test(b)));
});

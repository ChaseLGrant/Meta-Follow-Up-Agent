import { audit } from './db.js';
import { log, maskPhone } from './log.js';
import { isWithinSendWindow, nextSendTime } from './quietHours.js';
import { refreshStatus } from './status.js';
import { OPTED_OUT_CODE } from './sms.js';
import { notifyOwner, leadSummary } from './notify.js';

// Every outbound automated text goes through processMessage(). It is the ONLY place that calls
// Twilio for leads, so the safety rules live here:
//   - claim the row atomically (status scheduled -> sending) so a text can never go out twice
//   - re-check opt-out, consent, booked/replied, quiet hours and the hourly cap at send time
//   - respect SMS_MODE (dry_run / test allowlist / live)
//   - transient errors retry later; permanent errors mark the lead FAILED and alert Chase

const RETRY_DELAYS_MIN = [2, 10, 30];
const SEQUENCE = ['initial', 'fu1', 'fu2'];

export async function processMessage(deps, messageId) {
  const { db, config } = deps;
  const now = deps.now();

  const { rows: claimed } = await db.query(
    `update messages set status = 'sending', claimed_at = $2, attempts = attempts + 1
     where id = $1 and status = 'scheduled' and scheduled_for <= $2 returning *`,
    [messageId, now],
  );
  const msg = claimed[0];
  if (!msg) return { skipped: 'not_due_or_already_claimed' };

  const { rows: leads } = await db.query('select * from leads where id = $1', [msg.lead_id]);
  const lead = leads[0];

  const stop = reasonNotToSend(lead, msg);
  if (stop) {
    await db.query(`update messages set status = 'canceled', error_message = $2 where id = $1`, [msg.id, stop]);
    log.info('sms_canceled', { message: msg.id, kind: msg.kind, reason: stop });
    return { canceled: stop };
  }

  if (!isWithinSendWindow(now, lead.timezones, config.quietStartHour, config.quietEndHour)) {
    const at = nextSendTime(now, lead.timezones, config.quietStartHour, config.quietEndHour);
    await requeue(db, msg.id, at, false);
    return { deferredUntil: at, reason: 'quiet_hours' };
  }

  const { rows: rate } = await db.query(
    `select count(*)::int as n from messages where direction = 'out' and id <> $1
       and sent_at > $2::timestamptz - interval '1 hour' and status in ('sent', 'delivered', 'simulated')`,
    [msg.id, now],
  );
  if (rate[0].n >= config.maxSmsPerHour) {
    const at = new Date(now.getTime() + 10 * 60e3);
    await requeue(db, msg.id, at, false);
    log.warn('sms_rate_limited', { message: msg.id });
    return { deferredUntil: at, reason: 'rate_limit' };
  }

  // Safety switch: nothing real goes out unless SMS_MODE says so.
  if (config.smsMode === 'dry_run') return markSent(deps, msg, lead, { status: 'simulated' });
  if (config.smsMode === 'test' && !config.smsTestAllowlist.includes(msg.to_phone)) {
    await db.query(`update messages set status = 'blocked_test_mode', error_message = $2 where id = $1`,
      [msg.id, 'SMS_MODE=test and number is not in SMS_TEST_ALLOWLIST']);
    return { blocked: 'test_mode' };
  }

  try {
    const res = await deps.sms.send({
      to: msg.to_phone,
      body: msg.body,
      statusCallback: config.publicBaseUrl ? `${config.publicBaseUrl}/hooks/twilio/status` : undefined,
    });
    return markSent(deps, msg, lead, { status: 'sent', sid: res.sid });
  } catch (err) {
    return handleSendError(deps, msg, lead, err);
  }
}

function reasonNotToSend(lead, msg) {
  if (!lead) return 'lead_missing';
  if (lead.do_not_text) return 'do_not_text';
  if (!lead.sms_consent) return 'no_sms_consent';
  if (!msg.to_phone) return 'no_phone';
  if (SEQUENCE.includes(msg.kind)) {
    if (['BOOKED', 'SHOWED', 'NO_SHOW'].includes(lead.booking_status)) return 'already_booked';
    if (lead.replied_at) return 'lead_replied';
    if (lead.booking_status === 'CANCELED') return 'booking_canceled';
  }
  return null;
}

async function requeue(db, id, at, countsAsAttempt) {
  await db.query(
    `update messages set status = 'scheduled', scheduled_for = $2, claimed_at = null,
       attempts = attempts - $3 where id = $1`,
    [id, at, countsAsAttempt ? 0 : 1],
  );
}

async function markSent(deps, msg, lead, { status, sid = null }) {
  const { db } = deps;
  const now = deps.now();
  await db.query(
    `update messages set status = $2, provider_sid = $3, sent_at = $4, error_code = null, error_message = null
     where id = $1`,
    [msg.id, status, sid, now],
  );
  await db.query(
    `update leads set
       first_text_sent_at = case when $2 = 'initial' then coalesce(first_text_sent_at, $3) else first_text_sent_at end,
       sequence_completed_at = case when $2 = 'fu2' then coalesce(sequence_completed_at, $3) else sequence_completed_at end,
       last_message_at = $3, last_message_preview = left($4, 160), last_message_direction = 'out'
     where id = $1`,
    [lead.id, msg.kind, now, msg.body],
  );
  await audit(db, lead.id, 'sms_sent', { kind: msg.kind, status, sid });
  await refreshStatus(db, lead.id);
  log.info('sms_sent', { lead: lead.id, kind: msg.kind, status, to: maskPhone(msg.to_phone) });
  return { sent: status, sid };
}

async function handleSendError(deps, msg, lead, err) {
  const { db, config } = deps;
  const now = deps.now();
  log.error('sms_send_error', { message: msg.id, kind: msg.kind, code: err.code, error: err.message });

  if (!err.permanent && msg.attempts <= RETRY_DELAYS_MIN.length) {
    const at = new Date(now.getTime() + RETRY_DELAYS_MIN[msg.attempts - 1] * 60e3);
    await db.query(
      `update messages set status = 'scheduled', scheduled_for = $2, claimed_at = null, error_code = $3,
         error_message = $4 where id = $1`,
      [msg.id, at, err.code || null, err.message],
    );
    return { retryAt: at, error: err.message };
  }

  await db.query(`update messages set status = 'failed', error_code = $2, error_message = $3 where id = $1`,
    [msg.id, err.code || null, err.message]);

  if (err.code === OPTED_OUT_CODE) {
    // The carrier/Twilio says this number already texted STOP to us. Honor it everywhere.
    await markOptedOut(deps, lead.id, 'carrier_reports_unsubscribed');
    return { failed: err.message, optedOut: true };
  }

  await db.query('update leads set sms_failed = true where id = $1', [lead.id]);
  await audit(db, lead.id, 'sms_failed', { kind: msg.kind, code: err.code, error: err.message });
  await refreshStatus(db, lead.id);
  await notifyOwner(deps, {
    kind: 'sms_failed', leadId: lead.id, dedupeKey: `sms_failed:${lead.id}`,
    subject: 'Text to a lead failed — call them instead',
    body: `Couldn't text this lead (${err.message}).\n${leadSummary(lead, config)}`,
  });
  return { failed: err.message };
}

export async function markOptedOut(deps, leadId, reason, detail = {}) {
  const { db } = deps;
  await db.query(
    `update leads set do_not_text = true, opted_out_at = coalesce(opted_out_at, $2) where id = $1`,
    [leadId, deps.now()],
  );
  const { rows } = await db.query(
    `update messages set status = 'canceled', error_message = 'opted_out'
     where lead_id = $1 and status = 'scheduled' returning kind`,
    [leadId],
  );
  await audit(db, leadId, 'opted_out', { reason, canceled: rows.map((r) => r.kind), ...detail });
  await refreshStatus(db, leadId);
}

export async function processDueMessages(deps, limit = 50) {
  const { rows } = await deps.db.query(
    `select id from messages where status = 'scheduled' and scheduled_for <= $1
     order by scheduled_for limit $2`,
    [deps.now(), limit],
  );
  const results = [];
  for (const r of rows) {
    try {
      results.push(await processMessage(deps, r.id));
    } catch (e) {
      log.error('process_message_crashed', { message: r.id, error: e.message });
    }
  }
  return results;
}

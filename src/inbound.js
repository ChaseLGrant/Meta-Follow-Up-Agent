import { audit } from './db.js';
import { log, maskPhone } from './log.js';
import { toE164 } from './phone.js';
import { refreshStatus, cancelPendingSequence } from './status.js';
import { markOptedOut } from './sender.js';
import { notifyOwner, leadSummary } from './notify.js';

// Inbound texts. The automation NEVER writes replies to parents — Chase does. Its job here:
//   1. honor opt-outs immediately (STOP and plain-English versions of it)
//   2. stop automated follow-ups as soon as a parent starts a real conversation
//   3. save the conversation and alert Chase right away (flagging high-intent messages)

// Carrier-standard keywords (CTIA) + FCC 2025 "reasonable means" revocation words.
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out', 'remove']);
const OPT_IN_KEYWORDS = new Set(['start', 'unstop']);
const HELP_KEYWORDS = new Set(['help', 'info']);
const NATURAL_OPT_OUT = new RegExp([
  "^stop\\b", "\\bstop (texting|messaging|contacting|sending)", "\\b(don'?t|do not|dont) (text|message|contact)",
  "\\bremove (me|my number|this number)", "\\btake me off", "\\bunsubscribe", "\\bleave me alone",
  "\\bno more (texts|messages)", "\\bwrong (number|person)", "\\blose (my|this) number",
].join('|'), 'i');

// Signals that a parent wants to talk / buy. Used only to flag the alert to Chase as urgent.
const HIGH_INTENT = new RegExp([
  '\\bcall\\b', '\\btalk\\b', '\\bspeak\\b', '\\bphone\\b', '\\bprice', '\\bpricing\\b', '\\bcost', '\\bhow much\\b',
  '\\binterested\\b', '\\bsign (him|her|them|us|up)\\b', '\\bsign ?up\\b', '\\benroll', '\\bbook', '\\bschedul',
  '\\bavailab', '\\bwhen can\\b', '\\bfree (to|today|tomorrow|now)\\b', '\\btoday\\b', '\\btomorrow\\b', '\\btonight\\b',
  '\\basap\\b', "\\blet'?s do\\b", '\\bsounds good\\b', '\\bready\\b', '\\byes\\b', '\\byeah\\b', '\\bsure\\b',
  '\\bpayment', '\\bprogram\\b', '\\bhelp (him|her|them|us)\\b',
].join('|'), 'i');

export function classifyInbound(body, optOutType) {
  const t = String(body || '').trim();
  const word = t.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const type = String(optOutType || '').toUpperCase();
  if (type === 'STOP' || OPT_OUT_KEYWORDS.has(word) || NATURAL_OPT_OUT.test(t)) return { kind: 'opt_out' };
  if (type === 'START' || OPT_IN_KEYWORDS.has(word)) return { kind: 'opt_in' };
  if (type === 'HELP' || HELP_KEYWORDS.has(word)) return { kind: 'help' };
  return { kind: 'reply', highIntent: HIGH_INTENT.test(t) };
}

export async function handleInboundSms(deps, { from, body, sid, optOutType }) {
  const { db, config } = deps;
  const now = deps.now();
  const phone = toE164(from) || from;
  if (config.ownerPhone && phone === config.ownerPhone) return { ignored: 'from_owner' };

  const { rows } = await db.query('select * from leads where phone_e164 = $1', [phone]);
  const lead = rows[0] || null;
  const c = classifyInbound(body, optOutType);

  const { rows: ins } = await db.query(
    `insert into messages (lead_id, direction, kind, from_phone, body, status, sent_at, provider_sid)
     values ($1, 'in', 'reply', $2, $3, 'received', $4, $5)
     on conflict (provider_sid) do nothing returning id`,
    [lead?.id || null, phone, body || '', now, sid || null],
  );
  if (!ins[0]) return { duplicate: true };
  log.info('sms_inbound', { lead: lead?.id || null, from: maskPhone(phone), kind: c.kind, highIntent: !!c.highIntent });

  if (!lead) {
    if (c.kind === 'opt_out') return { kind: c.kind, unknownSender: true };
    await notifyOwner(deps, {
      kind: 'unknown_sender', dedupeKey: `unknown:${sid}`,
      subject: 'Text from an unknown number',
      body: `From ${phone}:\n"${String(body).slice(0, 500)}"`,
    });
    return { kind: c.kind, unknownSender: true };
  }

  await db.query(
    `update leads set last_message_at = $2, last_message_preview = left($3, 160), last_message_direction = 'in'
     where id = $1`,
    [lead.id, now, body || ''],
  );

  if (c.kind === 'opt_out') {
    await markOptedOut(deps, lead.id, 'inbound_keyword', { message: String(body).slice(0, 160), sid });
    return { kind: 'opt_out', leadId: lead.id };
  }

  if (c.kind === 'opt_in') {
    await db.query('update leads set do_not_text = false where id = $1', [lead.id]);
    await audit(db, lead.id, 'sms_resubscribed', { message: body, sid });
    await refreshStatus(db, lead.id);
    await notifyOwner(deps, {
      kind: 'resubscribed', leadId: lead.id, dedupeKey: `resub:${sid}`,
      subject: 'A lead texted START (re-subscribed)',
      body: `They opted back in to texts. Automation will not restart — reach out personally.\n${leadSummary(lead, config)}`,
    });
    return { kind: 'opt_in', leadId: lead.id };
  }

  // A real reply (or HELP): stop the automated sequence and get Chase on it.
  await db.query('update leads set replied_at = coalesce(replied_at, $2) where id = $1', [lead.id, now]);
  const canceled = await cancelPendingSequence(db, lead.id, 'lead_replied');
  await audit(db, lead.id, 'replied', { high_intent: !!c.highIntent, help: c.kind === 'help', canceled_follow_ups: canceled });
  const updated = await refreshStatus(db, lead.id);
  const hot = c.highIntent;
  await notifyOwner(deps, {
    kind: hot ? 'high_intent_reply' : 'reply', leadId: lead.id, dedupeKey: `reply:${sid}`,
    subject: hot ? '🔥 HOT reply — call them now' : c.kind === 'help' ? 'A lead texted HELP' : 'New reply from a lead',
    body: `"${String(body).slice(0, 500)}"\n\n${leadSummary(updated, config)}\n\nAutomated follow-ups are stopped. ` +
      `Call them, or reply from the dashboard.`,
  });
  return { kind: c.kind, highIntent: !!hot, leadId: lead.id };
}

// Twilio delivery receipts.
const FINAL = { delivered: 'delivered', read: 'delivered', undelivered: 'undelivered', failed: 'failed' };

export async function handleDeliveryStatus(deps, { sid, status, errorCode }) {
  const { db, config } = deps;
  const next = FINAL[String(status || '').toLowerCase()];
  if (!next) return { ignored: status };
  const { rows } = await db.query(
    `update messages set status = $2, error_code = coalesce($3, error_code)
     where provider_sid = $1 and direction = 'out' and status in ('sending', 'sent') returning *`,
    [sid, next, errorCode || null],
  );
  const msg = rows[0];
  if (!msg) return { ignored: 'unknown_or_already_final' };

  if (next === 'delivered') {
    await db.query(
      `update leads set first_delivered_at = coalesce(first_delivered_at, $2), sms_failed = false where id = $1`,
      [msg.lead_id, deps.now()],
    );
    await refreshStatus(db, msg.lead_id);
    return { delivered: true };
  }

  if (String(errorCode) === '21610') {
    await markOptedOut(deps, msg.lead_id, 'carrier_reports_unsubscribed');
    return { optedOut: true };
  }
  await db.query('update leads set sms_failed = true where id = $1', [msg.lead_id]);
  await audit(db, msg.lead_id, 'sms_delivery_failed', { kind: msg.kind, status: next, error_code: errorCode || null });
  const lead = await refreshStatus(db, msg.lead_id);
  await notifyOwner(deps, {
    kind: 'sms_failed', leadId: msg.lead_id, dedupeKey: `sms_failed:${msg.lead_id}`,
    subject: 'Text to a lead was not delivered — call them instead',
    body: `Our "${msg.kind}" text was ${next}${errorCode ? ` (Twilio error ${errorCode})` : ''}.\n${leadSummary(lead, config)}`,
  });
  await checkRepeatedFailures(deps);
  return { failed: next };
}

// Several failures in a few hours usually means a provider/registration problem, not a bad number.
async function checkRepeatedFailures(deps) {
  const { db, config } = deps;
  const now = deps.now();
  const { rows } = await db.query(
    `select count(*)::int as n, array_agg(distinct error_code) filter (where error_code is not null) as codes
     from messages where direction = 'out' and status in ('failed', 'undelivered')
       and sent_at > $1::timestamptz - interval '6 hours'`,
    [now],
  );
  if (rows[0].n < config.failureAlertThreshold) return;
  const window = Math.floor(now.getTime() / (6 * 3600e3));
  const codes = (rows[0].codes || []).join(', ') || 'none';
  await notifyOwner(deps, {
    kind: 'sms_failures', dedupeKey: `sms_failures:${window}`,
    subject: `${rows[0].n} texts failed in the last 6 hours`,
    body: `Texts are repeatedly failing (Twilio error codes: ${codes}). 30007/30034 usually mean carrier ` +
      `filtering or an A2P 10DLC registration problem — check Twilio Console → Messaging → Logs.`,
  });
}

import { audit } from './db.js';
import { log } from './log.js';
import { toE164 } from './phone.js';
import { randomCode } from './security.js';
import { refreshStatus, cancelPendingSequence } from './status.js';
import { bookingConfirmText, formatWhen } from './messages.js';
import { isWithinSendWindow } from './quietHours.js';
import { notifyOwner, leadSummary } from './notify.js';
import { processMessage } from './sender.js';

// Calendly webhook events -> lead booking state.
//   invitee.created          booked (or rescheduled, when payload.old_invitee is set)
//   invitee.canceled         canceled (ignored when it's the "old half" of a reschedule)
//   invitee_no_show.created  no-show marked in Calendly
//   invitee_no_show.deleted  no-show mark removed

export async function handleCalendlyEvent(deps, evt) {
  const p = evt.payload || {};
  switch (evt.event) {
    case 'invitee.created': return onBooked(deps, p);
    case 'invitee.canceled': return onCanceled(deps, p);
    case 'invitee_no_show.created': return onNoShow(deps, p, true);
    case 'invitee_no_show.deleted': return onNoShow(deps, p, false);
    default: return { ignored: evt.event };
  }
}

function phoneFrom(p) {
  const candidates = [p.text_reminder_number, p.scheduled_event?.location?.location,
    ...(p.questions_and_answers || []).map((q) => q.answer)];
  for (const c of candidates) {
    const e = toE164(c);
    if (e) return e;
  }
  return null;
}

async function findLeadForInvitee(db, p) {
  const tries = [
    ['calendly_invitee_uri = $1', p.old_invitee],
    ['calendly_invitee_uri = $1', p.uri],
    ['link_code = $1', p.tracking?.utm_content],
    ['lower(email) = lower($1)', p.email],
    ['phone_e164 = $1', phoneFrom(p)],
  ];
  for (const [where, val] of tries) {
    if (!val) continue;
    const { rows } = await db.query(`select * from leads where ${where} order by received_at desc limit 1`, [val]);
    if (rows[0]) return rows[0];
  }
  return null;
}

async function onBooked(deps, p) {
  const { db, config } = deps;
  const now = deps.now();
  const start = new Date(p.scheduled_event?.start_time);
  if (isNaN(start)) throw new Error('Calendly invitee.created without scheduled_event.start_time');

  let lead = await findLeadForInvitee(db, p);
  let matched = !!lead;
  if (!lead) {
    // Booked without coming through a lead form (e.g. shared link). Track it; never text (no consent).
    const { rows } = await db.query(
      `insert into leads (received_at, parent_first, parent_last, email, phone_e164, lead_source, link_code)
       values ($1, $2, $3, $4, $5, 'calendly_direct', $6)
       on conflict (phone_e164) where phone_e164 is not null do nothing returning *`,
      [now, p.first_name || (p.name || '').split(' ')[0] || null,
        p.last_name || (p.name || '').split(' ').slice(1).join(' ') || null,
        p.email ? p.email.toLowerCase() : null, phoneFrom(p), randomCode()],
    );
    lead = rows[0] || (await findLeadForInvitee(db, p));
    await audit(db, lead.id, 'lead_received', { source: 'calendly_direct' });
  }

  const isReschedule = !!p.old_invitee && lead.calendly_invitee_uri === p.old_invitee;
  await db.query(
    `update leads set booking_status = 'BOOKED', booked_at = coalesce(booked_at, $2), appointment_at = $3,
       calendly_invitee_uri = $4, calendly_reschedule_url = $5,
       rescheduled_count = rescheduled_count + $6 where id = $1`,
    [lead.id, now, start, p.uri, p.reschedule_url || null, isReschedule ? 1 : 0],
  );
  const canceled = await cancelPendingSequence(db, lead.id, 'booked');
  await audit(db, lead.id, isReschedule ? 'booking_rescheduled' : 'booked', {
    appointment_at: start, invitee: p.uri, matched_by_tracking: p.tracking?.utm_content === lead.link_code,
    canceled_follow_ups: canceled,
  });
  lead = await refreshStatus(db, lead.id);

  // Confirmation text (Calendly also emails a confirmation + reminders).
  const leadZone = lead.timezones?.[0] || config.ownerTimezone;
  let confirmation = null;
  if (lead.sms_consent && !lead.do_not_text && lead.phone_e164) {
    if (isWithinSendWindow(now, lead.timezones, config.quietStartHour, config.quietEndHour)) {
      const body = bookingConfirmText({ parentFirst: lead.parent_first, when: formatWhen(start, leadZone), rescheduled: isReschedule });
      const { rows } = await db.query(
        `insert into messages (lead_id, direction, kind, to_phone, body, status, scheduled_for)
         values ($1, 'out', 'booking_confirm', $2, $3, 'scheduled', $4) returning id`,
        [lead.id, lead.phone_e164, body, now],
      );
      confirmation = await processMessage(deps, rows[0].id);
    } else {
      confirmation = { skipped: 'quiet_hours (Calendly email confirmation still sent)' };
      await audit(db, lead.id, 'booking_confirmation_skipped', { reason: 'quiet_hours' });
    }
  }

  await notifyOwner(deps, {
    kind: isReschedule ? 'rescheduled' : 'booked', leadId: lead.id, dedupeKey: `booked:${p.uri}`,
    subject: isReschedule ? 'Call rescheduled' : 'New call booked!',
    body: `${isReschedule ? 'Rescheduled to' : 'Booked for'} ${formatWhen(start, config.ownerTimezone)}` +
      `${matched ? '' : ' (booked directly — not from a lead form)'}\n${leadSummary(lead, config)}`,
  });
  log.info('booking_recorded', { lead: lead.id, reschedule: isReschedule, matched });
  return { leadId: lead.id, booked: true, rescheduled: isReschedule, matched, confirmation };
}

async function onCanceled(deps, p) {
  const { db, config } = deps;
  if (p.rescheduled) {
    // Old half of a reschedule — the matching invitee.created carries the new time.
    const lead = await findLeadForInvitee(db, { uri: p.uri });
    if (lead) await audit(db, lead.id, 'booking_reschedule_started', { old_invitee: p.uri });
    return { ignored: 'reschedule' };
  }
  const { rows } = await db.query('select * from leads where calendly_invitee_uri = $1', [p.uri]);
  const lead = rows[0];
  if (!lead) return { ignored: 'unknown_invitee' };
  await db.query(`update leads set booking_status = 'CANCELED', appointment_at = null where id = $1`, [lead.id]);
  await audit(db, lead.id, 'booking_canceled', {
    reason: p.cancellation?.reason || null, canceled_by: p.cancellation?.canceler_type || null,
  });
  const updated = await refreshStatus(db, lead.id);
  await notifyOwner(deps, {
    kind: 'booking_canceled', leadId: lead.id, dedupeKey: `canceled:${p.uri}`,
    subject: 'A booked call was canceled',
    body: `Call canceled${p.cancellation?.reason ? ` — reason: "${p.cancellation.reason}"` : ''}. ` +
      `Automated texts will NOT restart; reach out personally if you want to rebook.\n${leadSummary(updated, config)}`,
  });
  return { leadId: lead.id, canceled: true };
}

async function onNoShow(deps, p, isNoShow) {
  const { db } = deps;
  const inviteeUri = typeof p.invitee === 'string' ? p.invitee : p.invitee?.uri;
  const { rows } = await db.query('select id from leads where calendly_invitee_uri = $1', [inviteeUri]);
  if (!rows[0]) return { ignored: 'unknown_invitee' };
  await db.query('update leads set booking_status = $2 where id = $1', [rows[0].id, isNoShow ? 'NO_SHOW' : 'BOOKED']);
  await audit(db, rows[0].id, isNoShow ? 'no_show' : 'no_show_removed', {});
  await refreshStatus(db, rows[0].id);
  return { leadId: rows[0].id, noShow: isNoShow };
}

import { audit, firstTimeSeen } from './db.js';
import { log, maskPhone } from './log.js';
import { toE164 } from './phone.js';
import { zonesForCityState, nextSendTime } from './quietHours.js';
import { randomCode } from './security.js';
import { refreshStatus } from './status.js';
import { textForKind } from './messages.js';
import { smsLinkFor } from './links.js';
import { notifyOwner, leadSummary } from './notify.js';
import { processMessage } from './sender.js';

// The exact consent wording shown on the form, by version. Saved with every lead as evidence.
// If you change the checkbox text on the landing page, add a new version here.
export const CONSENT_TEXTS = {
  v1:
    'By checking this box, I agree to receive text messages from The Athlete Market about my ' +
    'recruiting application, including scheduling and follow-up messages, at the phone number ' +
    'provided. Consent is not a condition of purchase. Up to 4 msgs per inquiry. Msg & data rates ' +
    'may apply. Reply HELP for help, STOP to opt out.',
};

const yes = (v) => /^(yes|on|true|1|checked)$/i.test(String(v ?? '').trim());
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Netlify Forms outgoing-webhook payload -> normalized lead.
export function fromNetlify(payload) {
  const d = payload.data || {};
  const consent = yes(d.sms_consent);
  const version = str(d.sms_consent_version) || 'v1';
  return {
    externalId: payload.id ? `netlify:${payload.id}` : null,
    outcome: str(d.outcome) || 'qualified_application',
    receivedAt: payload.created_at ? new Date(payload.created_at) : null,
    parentFirst: str(d.parent_first), parentLast: str(d.parent_last),
    phone: str(d.phone), email: str(d.email),
    athleteFirst: str(d.athlete_first), athleteLast: str(d.athlete_last),
    sport: str(d.sport), gradYear: str(d.grad_year), cityState: str(d.city_state),
    leadSource: str(d.source) || 'landing_page',
    campaign: pick(d, ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'landing_url', 'referrer']),
    formAnswers: pick(d, ['status', 'challenges', 'importance', 'timeline', 'budget', 'position', 'high_school', 'gpa', 'film_url', 'best_time', 'notes', 'seconds_to_complete']),
    smsConsent: consent,
    consentEvidence: consent ? {
      method: 'web_form_checkbox',
      text_version: version,
      text: CONSENT_TEXTS[version] || null,
      captured_at: payload.created_at || null,
      page: d.landing_url || payload.site_url || null,
      ip: d.ip || null,
      user_agent: d.user_agent || null,
      form_submission_id: payload.id || null,
    } : null,
  };
}

// Any other source (e.g. Zapier from Meta Lead Ads) can POST this simple JSON shape with
// Authorization: Bearer <LEAD_INTAKE_TOKEN>. sms_consent must be true AND sms_consent_text supplied.
export function fromGeneric(body) {
  const consent = body.sms_consent === true && !!str(body.sms_consent_text);
  return {
    externalId: body.external_id ? `api:${body.external_id}` : null,
    outcome: 'qualified_application',
    receivedAt: body.submitted_at ? new Date(body.submitted_at) : null,
    parentFirst: str(body.parent_first), parentLast: str(body.parent_last),
    phone: str(body.phone), email: str(body.email),
    athleteFirst: str(body.athlete_first), athleteLast: str(body.athlete_last),
    sport: str(body.sport), gradYear: str(body.grad_year), cityState: str(body.city_state),
    leadSource: str(body.lead_source) || 'api',
    campaign: body.campaign && typeof body.campaign === 'object' ? body.campaign : {},
    formAnswers: body.answers && typeof body.answers === 'object' ? body.answers : {},
    smsConsent: consent,
    consentEvidence: consent ? {
      method: str(body.sms_consent_method) || 'api', text: str(body.sms_consent_text),
      captured_at: body.sms_consent_at || body.submitted_at || null, source: str(body.lead_source) || 'api',
    } : null,
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

export async function ingestLead(deps, input) {
  const { db, config } = deps;
  const now = deps.now();

  if (input.outcome !== 'qualified_application') return { ignored: `outcome:${input.outcome}` };
  const phone = toE164(input.phone);
  const email = input.email ? input.email.toLowerCase() : '';
  if (!phone && !email) return { ignored: 'no_contact_info' };

  // Exact replay of the same submission (provider retry) -> do nothing.
  if (input.externalId && !(await firstTimeSeen(db, 'lead', input.externalId))) {
    return { duplicate: true, replay: true };
  }

  const existing = await findExisting(db, phone, email);
  if (existing) return handleResubmission(deps, existing, input, phone);

  const zones = zonesForCityState(input.cityState);
  const receivedAt = input.receivedAt && !isNaN(input.receivedAt) && input.receivedAt <= now ? input.receivedAt : now;
  const { rows } = await db.query(
    `insert into leads (received_at, parent_first, parent_last, phone_e164, email, athlete_first, athlete_last,
       sport, grad_year, city_state, timezones, lead_source, campaign, form_answers, sms_consent,
       sms_consent_evidence, link_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (phone_e164) where phone_e164 is not null do nothing
     returning *`,
    [receivedAt, input.parentFirst, input.parentLast, phone, email || null, input.athleteFirst, input.athleteLast,
      input.sport, input.gradYear, input.cityState, zones, input.leadSource, JSON.stringify(input.campaign),
      JSON.stringify(input.formAnswers), input.smsConsent && !!phone, input.consentEvidence ? JSON.stringify(input.consentEvidence) : null,
      randomCode()],
  );
  if (!rows[0]) {
    // Lost a race with a simultaneous submission for the same phone.
    return handleResubmission(deps, await findExisting(db, phone, email), input, phone);
  }
  const lead = rows[0];
  await audit(db, lead.id, 'lead_received', { source: input.leadSource, external_id: input.externalId });
  log.info('lead_received', { lead: lead.id, phone: maskPhone(phone), consent: lead.sms_consent });

  if (lead.sms_consent) {
    await audit(db, lead.id, 'sms_consent_captured', input.consentEvidence);
    const scheduled = await scheduleSequence(deps, lead);
    await refreshStatus(db, lead.id);
    // Speed to lead: send the first text right now (unless it's quiet hours for them).
    let first = null;
    if (scheduled.initial && scheduled.initial.at <= now) first = await processMessage(deps, scheduled.initial.id);
    return { leadId: lead.id, created: true, initial: first || { deferredUntil: scheduled.initial?.at } };
  }

  await refreshStatus(db, lead.id);
  await notifyOwner(deps, {
    kind: 'no_consent_lead', leadId: lead.id, dedupeKey: `no_consent:${lead.id}`,
    subject: 'New lead — no SMS consent, call or email them',
    body: `New application, but they didn't opt in to texts so the automation won't text them.\n${leadSummary(lead, config)}`,
  });
  return { leadId: lead.id, created: true, initial: { skipped: phone ? 'no_sms_consent' : 'no_valid_phone' } };
}

async function findExisting(db, phone, email) {
  const { rows } = await db.query(
    `select * from leads where ($1::text is not null and phone_e164 = $1)
       or ($2::text <> '' and lower(email) = $2)
     order by (phone_e164 = $1) desc nulls last, received_at asc limit 1`,
    [phone, email || ''],
  );
  return rows[0] || null;
}

// Same family submitted again: keep ONE lead, fill in blanks, never restart the sequence.
async function handleResubmission(deps, lead, input, phone) {
  const { db, config } = deps;
  const newConsent = input.smsConsent && !!(lead.phone_e164 || phone) && !lead.sms_consent && !lead.do_not_text;
  const { rows } = await db.query(
    `update leads set submission_count = submission_count + 1,
       parent_first = coalesce(nullif(parent_first, ''), $2), parent_last = coalesce(nullif(parent_last, ''), $3),
       phone_e164 = coalesce(phone_e164, $4), email = coalesce(email, nullif($5, '')),
       athlete_first = coalesce(nullif(athlete_first, ''), $6), athlete_last = coalesce(nullif(athlete_last, ''), $7),
       sport = coalesce(nullif(sport, ''), $8), grad_year = coalesce(nullif(grad_year, ''), $9),
       sms_consent = sms_consent or $10, sms_consent_evidence = coalesce(sms_consent_evidence, $11)
     where id = $1 returning *`,
    [lead.id, input.parentFirst, input.parentLast, phone, input.email.toLowerCase(), input.athleteFirst,
      input.athleteLast, input.sport, input.gradYear, newConsent,
      newConsent ? JSON.stringify(input.consentEvidence) : null],
  );
  const updated = rows[0];
  await audit(db, lead.id, 'lead_resubmitted', { external_id: input.externalId, new_consent: newConsent });

  // Only start texting if this family has NEVER been in the sequence (first time they gave consent).
  let initial = null;
  if (newConsent) {
    await audit(db, lead.id, 'sms_consent_captured', input.consentEvidence);
    const { rows: seq } = await db.query(
      `select 1 from messages where lead_id = $1 and kind = 'initial'`, [lead.id]);
    if (!seq.length && updated.booking_status === 'NOT_BOOKED' && !updated.replied_at) {
      const s = await scheduleSequence(deps, updated);
      if (s.initial && s.initial.at <= deps.now()) initial = await processMessage(deps, s.initial.id);
    }
  }
  await refreshStatus(db, lead.id);
  await notifyOwner(deps, {
    kind: 'lead_resubmitted', leadId: lead.id,
    dedupeKey: `resubmitted:${lead.id}:${deps.now().toISOString().slice(0, 10)}`,
    subject: 'A lead submitted the form again',
    body: `This family re-submitted the application (could be a good sign — consider calling).\n${leadSummary(updated, config)}`,
  });
  return { leadId: lead.id, duplicate: true, initial };
}

export async function scheduleSequence(deps, lead) {
  const { db, config } = deps;
  const now = deps.now();
  const link = smsLinkFor(config, lead);
  const vars = { parentFirst: lead.parent_first, athleteFirst: lead.athlete_first, link };
  const zones = lead.timezones;
  const received = new Date(lead.received_at);
  const plan = [
    ['initial', now],
    ['fu1', new Date(received.getTime() + config.followUp1Hours * 3600e3)],
    ['fu2', new Date(received.getTime() + config.followUp2Hours * 3600e3)],
  ];
  const out = {};
  for (const [kind, due] of plan) {
    const at = nextSendTime(due < now ? now : due, zones, config.quietStartHour, config.quietEndHour);
    const { rows } = await db.query(
      `insert into messages (lead_id, direction, kind, to_phone, body, status, scheduled_for)
       values ($1, 'out', $2, $3, $4, 'scheduled', $5)
       on conflict (lead_id, kind) where kind in ('initial','fu1','fu2') do nothing returning id`,
      [lead.id, kind, lead.phone_e164, textForKind(kind, vars), at],
    );
    if (rows[0]) out[kind] = { id: rows[0].id, at };
  }
  await audit(db, lead.id, 'sequence_scheduled', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.at])));
  return out;
}

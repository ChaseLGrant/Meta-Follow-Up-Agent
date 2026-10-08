import { log } from './log.js';

// Alerts to Chase: a text to OWNER_PHONE (Twilio) and/or an email to OWNER_EMAIL (Resend).
// A notification problem is logged but never breaks lead processing.
// `dedupeKey` makes an alert fire at most once (e.g. one "no leads lately" alert per quiet spell).

export async function notifyOwner(deps, { kind, subject, body, leadId = null, dedupeKey = null }) {
  const { db, config } = deps;
  const { rows } = await db.query(
    `insert into owner_alerts (kind, dedupe_key, lead_id, body) values ($1, $2, $3, $4)
     on conflict (dedupe_key) do nothing returning id`,
    [kind, dedupeKey, leadId, body],
  );
  if (!rows[0]) return { skipped: 'duplicate' };
  const alertId = rows[0].id;
  const delivery = {};

  if (config.ownerPhone) {
    if (config.smsMode === 'dry_run') delivery.sms = 'simulated';
    else {
      try {
        const text = `[TAM] ${subject}\n${body}`.slice(0, 1200);
        const r = await deps.sms.send({ to: config.ownerPhone, body: text });
        delivery.sms = r.sid || 'sent';
      } catch (e) {
        delivery.sms = 'error: ' + e.message;
        log.error('owner_sms_failed', { kind, error: e.message });
      }
    }
  }

  if (config.ownerEmail && config.resendApiKey && config.alertFromEmail) {
    try {
      const res = await deps.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.alertFromEmail, to: [config.ownerEmail], subject: `[Athlete Market] ${subject}`, text: body,
        }),
      });
      delivery.email = res.ok ? 'sent' : `error: HTTP ${res.status}`;
    } catch (e) {
      delivery.email = 'error: ' + e.message;
      log.error('owner_email_failed', { kind, error: e.message });
    }
  }

  await db.query('update owner_alerts set delivery = $2 where id = $1', [alertId, JSON.stringify(delivery)]);
  log.info('owner_notified', { kind, delivery });
  return { delivery };
}

export function leadSummary(lead, config) {
  const name = [lead.parent_first, lead.parent_last].filter(Boolean).join(' ') || 'Unknown parent';
  const athlete = [lead.athlete_first, lead.athlete_last].filter(Boolean).join(' ');
  const bits = [athlete, lead.sport, lead.grad_year && `'${String(lead.grad_year).slice(-2)}`].filter(Boolean).join(' · ');
  const lines = [`${name}${bits ? ` — ${bits}` : ''}`, `Phone: ${lead.phone_e164 || 'n/a'}`];
  if (lead.email) lines.push(`Email: ${lead.email}`);
  if (config.publicBaseUrl) lines.push(`${config.publicBaseUrl}/dashboard?lead=${lead.id}`);
  return lines.join('\n');
}

import { log } from './log.js';
import { audit } from './db.js';
import { processDueMessages } from './sender.js';
import { notifyOwner } from './notify.js';
import { refreshStatus } from './status.js';

// Runs every 5 minutes (Netlify scheduled function). Sends due follow-ups / deferred texts / retries,
// recovers stuck sends, and checks that leads are still arriving.
export async function runScheduler(deps) {
  const recovered = await recoverStuckSends(deps);
  const results = await processDueMessages(deps);
  const silence = await checkLeadSilence(deps);
  log.info('scheduler_ran', { processed: results.length, recovered, silence });
  return { processed: results, recovered, silence };
}

// A row stuck in 'sending' means the function died mid-send. We can't know if Twilio got it, so we
// NEVER resend automatically (a duplicate text is worse than a missing one) — mark it and tell Chase.
async function recoverStuckSends(deps) {
  const { db } = deps;
  const { rows } = await db.query(
    `update messages set status = 'failed', error_message = 'send outcome unknown (function timed out)'
     where status = 'sending' and claimed_at < $1::timestamptz - interval '10 minutes'
     returning id, lead_id, kind`,
    [deps.now()],
  );
  for (const m of rows) {
    await audit(db, m.lead_id, 'sms_send_unknown', { kind: m.kind });
    await refreshStatus(db, m.lead_id);
    await notifyOwner(deps, {
      kind: 'sms_unknown', leadId: m.lead_id, dedupeKey: `sms_unknown:${m.id}`,
      subject: 'A text may not have gone out',
      body: `The "${m.kind}" text to a lead may not have sent (system timeout). Check the dashboard and text them yourself if needed.`,
    });
  }
  return rows.length;
}

// "The integration stopped receiving leads": alert once per quiet spell.
async function checkLeadSilence(deps) {
  const { db, config } = deps;
  const { rows } = await db.query(
    `select id, received_at from leads where lead_source <> 'calendly_direct' order by received_at desc limit 1`);
  if (!rows[0]) return 'no_leads_yet';
  const hours = (deps.now() - new Date(rows[0].received_at)) / 3600e3;
  if (hours < config.leadSilenceAlertHours) return 'ok';
  await notifyOwner(deps, {
    kind: 'lead_silence', dedupeKey: `lead_silence:${rows[0].id}`,
    subject: `No new leads in ${Math.floor(hours)} hours`,
    body: `The follow-up system hasn't received a lead in ${Math.floor(hours)} hours. ` +
      `If your Meta ads are running, check: (1) the landing page form still submits, (2) Netlify → Forms → ` +
      `Form notifications still has the outgoing webhook to /hooks/lead, (3) Netlify function logs for errors.`,
  });
  return 'alerted';
}

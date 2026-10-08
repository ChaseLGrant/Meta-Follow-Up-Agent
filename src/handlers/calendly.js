import { verifyCalendlySignature } from '../security.js';
import { firstTimeSeen, forgetEvent } from '../db.js';
import { handleCalendlyEvent } from '../booking.js';
import { json, safe } from '../http.js';
import { log } from '../log.js';

// POST /hooks/calendly — signed with Calendly-Webhook-Signature.
export const handleCalendlyWebhook = safe('calendly_webhook', async (deps, req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  const raw = await req.text();
  const sig = req.headers.get('calendly-webhook-signature');
  if (!verifyCalendlySignature(sig, raw, deps.config.calendlySigningKey, deps.now().getTime())) {
    log.warn('calendly_unauthorized');
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  const evt = JSON.parse(raw);
  const key = `${evt.event}:${evt.payload?.uri}:${evt.created_at}`;
  if (!(await firstTimeSeen(deps.db, 'calendly', key))) return json({ ok: true, duplicate: true });
  try {
    return json({ ok: true, ...(await handleCalendlyEvent(deps, evt)) });
  } catch (e) {
    await forgetEvent(deps.db, 'calendly', key).catch(() => {});
    throw e;
  }
});

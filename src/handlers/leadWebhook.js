import { verifyNetlifySignature, bearerOk } from '../security.js';
import { fromNetlify, fromGeneric, ingestLead } from '../leads.js';
import { forgetEvent } from '../db.js';
import { json, safe } from '../http.js';
import { log } from '../log.js';

// POST /hooks/lead
//   - Netlify Forms outgoing webhook (signed with X-Webhook-Signature), or
//   - any other source with Authorization: Bearer <LEAD_INTAKE_TOKEN>
export const handleLeadWebhook = safe('lead_webhook', async (deps, req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  const raw = await req.text();
  if (raw.length > 100_000) return json({ ok: false, error: 'too_large' }, 413);

  let input;
  const sig = req.headers.get('x-webhook-signature');
  if (sig && verifyNetlifySignature(sig, raw, deps.config.netlifyWebhookSecret)) {
    input = fromNetlify(JSON.parse(raw));
  } else if (bearerOk(req, deps.config.leadIntakeToken)) {
    input = fromGeneric(JSON.parse(raw));
  } else {
    log.warn('lead_webhook_unauthorized');
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  try {
    const result = await ingestLead(deps, input);
    return json({ ok: true, ...result });
  } catch (e) {
    // Let the provider's retry be processed instead of being dropped as a "duplicate".
    if (input.externalId) await forgetEvent(deps.db, 'lead', input.externalId).catch(() => {});
    throw e;
  }
});

import { verifyTwilioSignature } from '../security.js';
import { handleInboundSms, handleDeliveryStatus } from '../inbound.js';
import { json, text, safe } from '../http.js';
import { log } from '../log.js';

async function verified(deps, req, path) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  const url = `${deps.config.publicBaseUrl}${path}`;
  const ok = verifyTwilioSignature(req.headers.get('x-twilio-signature'), url, params, deps.config.twilio.authToken);
  if (!ok) log.warn('twilio_unauthorized', { path });
  return ok ? params : null;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// POST /hooks/twilio/inbound — Messaging Service "incoming message" webhook.
export const handleTwilioInbound = safe('twilio_inbound', async (deps, req) => {
  const p = await verified(deps, req, '/hooks/twilio/inbound');
  if (!p) return json({ ok: false, error: 'unauthorized' }, 403);
  await handleInboundSms(deps, { from: p.From, body: p.Body, sid: p.MessageSid, optOutType: p.OptOutType });
  return text(EMPTY_TWIML, 200, 'text/xml'); // no auto-reply: Chase replies personally
});

// POST /hooks/twilio/status — delivery receipts for messages we sent.
export const handleTwilioStatus = safe('twilio_status', async (deps, req) => {
  const p = await verified(deps, req, '/hooks/twilio/status');
  if (!p) return json({ ok: false, error: 'unauthorized' }, 403);
  const r = await handleDeliveryStatus(deps, { sid: p.MessageSid, status: p.MessageStatus, errorCode: p.ErrorCode });
  return json({ ok: true, ...r });
});

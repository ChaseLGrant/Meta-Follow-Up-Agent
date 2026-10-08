// Twilio REST client (no SDK needed). Retries network errors, 429 and 5xx with backoff.

export class SmsError extends Error {
  constructor(message, { code, permanent }) {
    super(message);
    this.code = code ? String(code) : undefined;
    this.permanent = !!permanent;
  }
}

// Twilio error codes that will never succeed on retry.
// 21610 = recipient replied STOP, 21211 = invalid number, 21614 = not a mobile number,
// 21408 = region not enabled, 21612 = cannot route, 30006 = landline/unreachable.
export const OPTED_OUT_CODE = '21610';

export function createTwilioClient(config, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { accountSid, authToken, messagingServiceSid, fromNumber } = config.twilio;
  return {
    async send({ to, body, statusCallback }) {
      if (!accountSid || !authToken || !(messagingServiceSid || fromNumber)) {
        throw new SmsError('Twilio is not configured', { code: 'not_configured', permanent: true });
      }
      const form = new URLSearchParams({ To: to, Body: body });
      if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
      else form.set('From', fromNumber);
      if (statusCallback) form.set('StatusCallback', statusCallback);

      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        let res;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
          });
        } catch (e) {
          lastErr = new SmsError('Network error calling Twilio: ' + e.message, { code: 'network' });
          await sleep(500 * attempt);
          continue;
        }
        const json = await res.json().catch(() => ({}));
        if (res.ok) return { sid: json.sid, status: json.status };
        const err = new SmsError(json.message || `Twilio HTTP ${res.status}`, {
          code: json.code || res.status,
          permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
        });
        if (err.permanent) throw err;
        lastErr = err;
        await sleep(500 * attempt);
      }
      throw lastErr;
    },
  };
}

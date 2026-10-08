// Sends a fake, correctly signed landing-page lead to your DEPLOYED follow-up site, exactly like
// Netlify would. Use YOUR OWN phone number to test the whole flow end to end.
//
//   PUBLIC_BASE_URL=https://your-site.netlify.app NETLIFY_WEBHOOK_SECRET=... \
//     node scripts/send-test-lead.js --phone "+17605551234" --name "Chase" --athlete "Test" --state "CA"
import { signNetlify } from '../src/security.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const secret = process.env.NETLIFY_WEBHOOK_SECRET;
const phone = arg('phone');
if (!base || !secret || !phone) {
  console.error('Need PUBLIC_BASE_URL, NETLIFY_WEBHOOK_SECRET and --phone');
  process.exit(1);
}
const payload = {
  id: `manual-test-${Date.now()}`,
  created_at: new Date().toISOString(),
  form_name: 'athlete-market',
  data: {
    parent_first: arg('name', 'Test'), parent_last: 'Parent', phone, email: arg('email', `test+${Date.now()}@example.com`),
    athlete_first: arg('athlete', 'Jake'), athlete_last: 'Test', sport: 'Baseball', grad_year: '2028',
    city_state: `Test City, ${arg('state', 'CA')}`, outcome: 'qualified_application', source: 'manual-test',
    sms_consent: 'yes', sms_consent_version: 'v1',
  },
};
const raw = JSON.stringify(payload);
const res = await fetch(`${base}/hooks/lead`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signNetlify(raw, secret) }, body: raw,
});
console.log(res.status, await res.text());

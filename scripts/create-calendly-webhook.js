// One-time: tells Calendly to notify this system about bookings, cancellations and no-shows.
// Calendly only allows this through its API (requires a paid Standard plan or higher).
//
//   CALENDLY_TOKEN=<personal access token> PUBLIC_BASE_URL=https://... \
//   CALENDLY_WEBHOOK_SIGNING_KEY=<same value as in Netlify> node scripts/create-calendly-webhook.js
const token = process.env.CALENDLY_TOKEN;
const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
if (!token || !base || !signingKey) {
  console.error('Need CALENDLY_TOKEN, PUBLIC_BASE_URL and CALENDLY_WEBHOOK_SIGNING_KEY');
  process.exit(1);
}
const api = (path, opts = {}) => fetch(`https://api.calendly.com${path}`, {
  ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const me = await api('/users/me');
if (me.status !== 200) { console.error('Token rejected:', me.body); process.exit(1); }
const { uri: user, current_organization: organization } = me.body.resource;
const res = await api('/webhook_subscriptions', {
  method: 'POST',
  body: JSON.stringify({
    url: `${base}/hooks/calendly`,
    events: ['invitee.created', 'invitee.canceled', 'invitee_no_show.created', 'invitee_no_show.deleted'],
    organization, user, scope: 'user', signing_key: signingKey,
  }),
});
console.log(res.status, JSON.stringify(res.body, null, 2));

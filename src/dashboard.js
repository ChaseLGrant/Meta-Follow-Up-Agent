import { basicAuthOk } from './security.js';
import { getMetrics } from './metrics.js';
import { audit } from './db.js';
import { refreshStatus } from './status.js';
import { processMessage, markOptedOut } from './sender.js';
import { text, safe } from './http.js';

// GET  /dashboard              — numbers + lead list (filter with ?status=REPLIED, ?days=7|30|90|all)
// GET  /dashboard?lead=<id>    — one lead: details, full conversation, audit trail, actions
// POST /dashboard              — actions (mark showed / no-show / closed, do-not-text, manual reply)
// Protected by HTTP Basic auth (any username, password = DASHBOARD_PASSWORD).

const STATUS_CARDS = [
  ['NEW', 'New leads'], ['TEXT_SENT', 'Text sent'], ['REPLIED', 'Replied'], ['BOOKED', 'Booked'],
  ['NO_RESPONSE', 'No response'], ['OPTED_OUT', 'Opted out'], ['FAILED', 'Failed'], ['NO_CONSENT', 'No SMS consent'],
];
const STATUS_LABEL = Object.fromEntries(STATUS_CARDS);
const BOOKING_LABEL = { NOT_BOOKED: '—', BOOKED: 'Booked', CANCELED: 'Canceled', SHOWED: 'Showed', NO_SHOW: 'No-show' };

const KIND_LABEL = { initial: 'first text', fu1: 'follow-up #1', fu2: 'follow-up #2', booking_confirm: 'booking confirmation' };
const MSG_STATUS = { canceled: 'not sent (canceled)', scheduled: 'scheduled', simulated: 'dry run (not really sent)', blocked_test_mode: 'not sent (test mode)' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const handleDashboard = safe('dashboard', async (deps, req) => {
  const { db, config } = deps;
  if (!config.dashboardPassword) return text('Set DASHBOARD_PASSWORD to enable the dashboard.', 503);

  const ip = (req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
  const { rows: fails } = await db.query(
    `select count(*)::int as n from auth_failures where ip = $1 and at > $2::timestamptz - interval '15 minutes'`,
    [ip, deps.now()],
  );
  if (fails[0].n >= 10) return text('Too many failed logins. Try again in 15 minutes.', 429);
  if (!basicAuthOk(req, config.dashboardPassword)) {
    if (req.headers.get('authorization')) await db.query('insert into auth_failures (ip, at) values ($1, $2)', [ip, deps.now()]);
    return new Response('Login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Athlete Market", charset="UTF-8"' } });
  }

  if (req.method === 'POST') return handleAction(deps, req);
  const url = new URL(req.url);
  if (url.searchParams.get('lead')) return leadPage(deps, url);
  return overviewPage(deps, url);
});

// ---------------------------------------------------------------- actions

async function handleAction(deps, req) {
  const { db, config } = deps;
  // CSRF protection: browsers send Origin on form posts; it must be this site.
  const origin = req.headers.get('origin');
  const self = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : new URL(req.url).origin;
  if (!origin || origin !== self) return text('Bad origin', 403);

  const form = Object.fromEntries(new URLSearchParams(await req.text()));
  const { rows } = await db.query('select * from leads where id = $1', [form.lead_id]);
  const lead = rows[0];
  if (!lead) return text('Lead not found', 404);
  const back = (msg) => Response.redirect(`${self}/dashboard?lead=${lead.id}&msg=${encodeURIComponent(msg)}`, 303);
  const setBooking = async (status, event) => {
    await db.query('update leads set booking_status = $2 where id = $1', [lead.id, status]);
    await audit(db, lead.id, event, { by: 'dashboard' });
    await refreshStatus(db, lead.id);
  };

  switch (form.action) {
    case 'showed': await setBooking('SHOWED', 'marked_showed'); return back('Marked as showed.');
    case 'no_show': await setBooking('NO_SHOW', 'marked_no_show'); return back('Marked as no-show.');
    case 'close_won':
      await db.query('update leads set closed_won = true, closed_at = $2 where id = $1', [lead.id, deps.now()]);
      await audit(db, lead.id, 'closed_won', { by: 'dashboard' });
      return back('Marked as closed — nice work.');
    case 'undo_close':
      await db.query('update leads set closed_won = false, closed_at = null where id = $1', [lead.id]);
      await audit(db, lead.id, 'closed_won_undone', { by: 'dashboard' });
      return back('Closed mark removed.');
    case 'do_not_text':
      await markOptedOut(deps, lead.id, 'marked_by_chase');
      return back('Marked do-not-text. No more texts will be sent.');
    case 'reply': {
      const body = String(form.body || '').trim().slice(0, 1000);
      if (!body) return back('Type a message first.');
      if (lead.do_not_text) return back('Not sent: this lead opted out of texts.');
      if (!lead.sms_consent) return back('Not sent: no SMS consent on file. Call or email instead.');
      const { rows: ins } = await db.query(
        `insert into messages (lead_id, direction, kind, to_phone, body, status, scheduled_for)
         values ($1, 'out', 'manual', $2, $3, 'scheduled', $4) returning id`,
        [lead.id, lead.phone_e164, body, deps.now()],
      );
      await audit(db, lead.id, 'manual_reply_queued', { by: 'dashboard' });
      const r = await processMessage(deps, ins[0].id);
      if (r.sent) return back(r.sent === 'simulated' ? 'Saved (dry-run mode: not actually sent).' : 'Sent.');
      if (r.deferredUntil) return back(`It's quiet hours for them — queued to send at ${fmt(r.deferredUntil, config.ownerTimezone)}.`);
      if (r.blocked) return back('Not sent: test mode and this number is not on the allowlist.');
      return back(`Not sent: ${r.failed || r.canceled || r.error || 'unknown error'}${r.retryAt ? ' (will retry automatically)' : ''}`);
    }
    default: return back('Unknown action.');
  }
}

// ---------------------------------------------------------------- pages

function fmt(d, tz, withTime = true) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(new Date(d));
}

const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

async function overviewPage(deps, url) {
  const { db, config } = deps;
  const tz = config.ownerTimezone;
  const daysParam = url.searchParams.get('days') || '30';
  const days = daysParam === 'all' ? null : Math.max(1, Math.min(3650, parseInt(daysParam, 10) || 30));
  const since = days ? new Date(deps.now().getTime() - days * 86400e3) : new Date(0);
  const status = url.searchParams.get('status');
  const m = await getMetrics(db, since);

  const params = [since];
  let where = 'received_at >= $1';
  if (status && STATUS_LABEL[status]) { params.push(status); where += ' and status = $2'; }
  const { rows: leads } = await db.query(
    `select * from leads where ${where} order by received_at desc limit 300`, params);

  const periodLinks = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']]
    .map(([v, l]) => `<a class="chip ${daysParam === v ? 'on' : ''}" href="?days=${v}">${l}</a>`).join('');

  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}</div>`;
  const kpis = [
    kpi('Lead → booked call', pct(m.lead_to_booked_rate), `${m.booked} of ${m.total_leads} leads`),
    kpi('Total leads', m.total_leads, `${m.sms_eligible} opted in to texts`),
    kpi('Texts delivered', m.texts_delivered, `${m.texts_sent} sent · ${m.texts_failed} failed`),
    kpi('SMS response rate', pct(m.response_rate), `${plural(m.replied, 'family', 'families')} replied`),
    kpi('Calendar link clicks', m.clicked, `${pct(m.click_rate)} of texted families`),
    kpi('Calls booked', m.booked, m.booked_direct ? `+${m.booked_direct} booked directly` : ''),
    kpi('Show rate', pct(m.show_rate), `${m.showed} showed · ${m.no_show} no-show`),
    kpi('Customers closed', m.closed, m.showed ? `${pct(m.close_rate)} of calls held` : 'mark on each lead'),
  ].join('');

  const keep = days ? `&days=${daysParam}` : '&days=all';
  const cards = STATUS_CARDS.map(([k, l]) =>
    `<a class="card s-${k} ${status === k ? 'on' : ''}" href="?status=${k}${keep}"><span class="n">${m.by_status[k] || 0}</span><span>${l}</span></a>`,
  ).join('');

  const rowsHtml = leads.map((l) => `
    <tr>
      <td data-l="Name"><a href="?lead=${l.id}">${esc([l.parent_first, l.parent_last].filter(Boolean).join(' ') || l.email || l.phone_e164)}</a></td>
      <td data-l="Athlete">${esc([l.athlete_first, l.athlete_last].filter(Boolean).join(' ') || '—')}</td>
      <td data-l="Sport">${esc(l.sport || '—')}</td>
      <td data-l="Grad">${esc(l.grad_year || '—')}</td>
      <td data-l="Received">${fmt(l.received_at, tz)}</td>
      <td data-l="Last message" class="last">${l.last_message_preview ? `<span class="dir">${l.last_message_direction === 'in' ? '← ' : '→ '}</span>${esc(l.last_message_preview.slice(0, 80))}` : '—'}</td>
      <td data-l="Status"><span class="badge s-${l.status}">${STATUS_LABEL[l.status] || l.status}</span></td>
      <td data-l="Booking">${BOOKING_LABEL[l.booking_status] || l.booking_status}${l.closed_won ? ' · <b>Closed</b>' : ''}</td>
      <td data-l="Appointment">${l.appointment_at ? fmt(l.appointment_at, tz) : '—'}</td>
    </tr>`).join('');

  const modeBanner = config.smsMode !== 'live'
    ? `<div class="banner">SMS mode: <b>${config.smsMode === 'dry_run' ? 'DRY RUN — no texts are actually sent' : 'TEST — only allowlisted numbers get texts'}</b></div>` : '';

  return page('Lead Dashboard', `
    ${modeBanner}
    <header><h1>Follow-up dashboard</h1><nav>${periodLinks}</nav></header>
    <section class="kpis">${kpis}</section>
    <section class="cards">${cards}${status ? `<a class="card clear" href="?${keep.slice(1)}">Show all</a>` : ''}</section>
    <section class="tablewrap">
      <table>
        <thead><tr><th>Name</th><th>Athlete</th><th>Sport</th><th>Grad</th><th>Received</th><th>Last message</th><th>Status</th><th>Booking</th><th>Appointment</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="9" class="empty">No leads in this view yet.</td></tr>'}</tbody>
      </table>
    </section>`);
}

async function leadPage(deps, url) {
  const { db, config } = deps;
  const tz = config.ownerTimezone;
  const { rows } = await db.query('select * from leads where id = $1', [url.searchParams.get('lead')]);
  const l = rows[0];
  if (!l) return text('Lead not found', 404);
  const { rows: msgs } = await db.query(
    `select * from messages where lead_id = $1 order by coalesce(sent_at, scheduled_for, created_at)`, [l.id]);
  const { rows: events } = await db.query('select * from lead_events where lead_id = $1 order by at desc limit 100', [l.id]);
  const flash = url.searchParams.get('msg');

  const a = l.form_answers || {};
  const c = l.campaign || {};
  const facts = [
    ['Parent', [l.parent_first, l.parent_last].filter(Boolean).join(' ')],
    ['Phone', l.phone_e164 ? `<a href="tel:${esc(l.phone_e164)}">${esc(l.phone_e164)}</a>` : '—', true],
    ['Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—', true],
    ['Athlete', [l.athlete_first, l.athlete_last].filter(Boolean).join(' ')],
    ['Sport / Grad', [l.sport, l.grad_year].filter(Boolean).join(' · ')],
    ['Location', l.city_state], ['Position', a.position], ['High school', a.high_school], ['GPA', a.gpa],
    ['Recruiting status', a.status], ['Biggest challenge', a.challenges], ['Importance', a.importance],
    ['Timeline', a.timeline], ['Budget', a.budget], ['Best time', a.best_time], ['Notes', a.notes],
    ['Film', a.film_url ? `<a href="${esc(a.film_url)}" target="_blank" rel="noopener noreferrer">${esc(a.film_url)}</a>` : '', true],
    ['Received', fmt(l.received_at, tz)], ['Source', [l.lead_source, c.utm_campaign, c.utm_content].filter(Boolean).join(' · ')],
    ['SMS consent', l.sms_consent ? `Yes (${esc(l.sms_consent_evidence?.method || '')}, ${fmt(l.sms_consent_evidence?.captured_at || l.received_at, tz)})` : 'No', true],
    ['Calendar clicks', String(l.link_clicks)],
    ['Appointment', l.appointment_at ? fmt(l.appointment_at, tz) : '—'],
  ].filter(([, v]) => v).map(([k, v, raw]) => `<dt>${k}</dt><dd>${raw ? v : esc(v)}</dd>`).join('');

  const thread = msgs.map((m) => `
    <div class="msg ${m.direction}${['canceled', 'scheduled', 'blocked_test_mode'].includes(m.status) ? ' unsent' : ''}">
      <div class="bubble">${esc(m.body).replace(/\n/g, '<br>')}</div>
      <div class="meta">${m.direction === 'in' ? 'Parent' : m.kind === 'manual' ? 'You' : `Auto · ${KIND_LABEL[m.kind] || m.kind}`} · ${esc(MSG_STATUS[m.status] || m.status)}${m.error_message ? ` (${esc(m.error_message)})` : ''} · ${fmt(m.sent_at || m.scheduled_for || m.created_at, tz)}</div>
    </div>`).join('');

  const btn = (action, label, cls = '') =>
    `<form method="post" action="/dashboard"><input type="hidden" name="lead_id" value="${l.id}"><input type="hidden" name="action" value="${action}"><button class="${cls}">${label}</button></form>`;
  const actions = [
    l.booked_at && btn('showed', 'Mark showed'),
    l.booked_at && btn('no_show', 'Mark no-show'),
    l.closed_won ? btn('undo_close', 'Undo closed') : btn('close_won', 'Mark closed (customer)', 'primary'),
    !l.do_not_text && btn('do_not_text', 'Do not text', 'danger'),
  ].filter(Boolean).join('');

  const canText = l.sms_consent && !l.do_not_text && l.phone_e164;
  const replyBox = canText ? `
    <form method="post" action="/dashboard" class="reply">
      <input type="hidden" name="lead_id" value="${l.id}"><input type="hidden" name="action" value="reply">
      <textarea name="body" rows="3" maxlength="1000" placeholder="Text ${esc(l.parent_first || 'them')} from the business number…"></textarea>
      <button class="primary">Send text</button>
    </form>` : `<p class="muted">${l.do_not_text ? 'Opted out — do not text.' : 'No SMS consent — call or email instead.'}</p>`;

  const ev = events.map((e) => `<li><span>${fmt(e.at, tz)}</span> ${esc(e.type.replace(/_/g, ' '))}</li>`).join('');

  return page('Lead', `
    <p><a href="/dashboard">← All leads</a></p>
    ${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
    <header><h1>${esc([l.parent_first, l.parent_last].filter(Boolean).join(' ') || 'Lead')}</h1>
      <span class="badge s-${l.status}">${STATUS_LABEL[l.status] || l.status}</span></header>
    <div class="actions">${actions}</div>
    <div class="cols">
      <section><h2>Details</h2><dl>${facts}</dl></section>
      <section><h2>Conversation</h2><div class="thread">${thread || '<p class="muted">No messages yet.</p>'}</div>${replyBox}</section>
    </div>
    <section><h2>Audit trail</h2><ul class="events">${ev}</ul></section>`);
}

function page(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Athlete Market</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--ink:#101828;--muted:#667085;--line:#e4e7ec;--accent:#1b5cff;--danger:#d92d20;
--new:#475467;--sent:#1b5cff;--replied:#7a5af8;--booked:#079455;--nores:#98a2b3;--opt:#b54708;--fail:#d92d20;--nocon:#667085}
@media (prefers-color-scheme:dark){:root{--bg:#0c111d;--panel:#161b26;--ink:#f5f5f6;--muted:#94969c;--line:#2a303c;--accent:#528bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}a{color:var(--accent);text-decoration:none}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:8px 0 16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 10px}
.chip{display:inline-block;padding:5px 10px;border:1px solid var(--line);border-radius:99px;color:var(--ink);margin-left:4px;background:var(--panel)}
.chip.on{background:var(--ink);color:var(--panel);border-color:var(--ink)}
.banner{background:#fef0c7;color:#7a2e0e;border-radius:8px;padding:8px 12px;margin-bottom:10px}
.flash{background:var(--panel);border-left:4px solid var(--accent);padding:10px 12px;border-radius:6px;margin-bottom:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi:first-child{border-color:var(--accent)}
.kpi-v{font-size:24px;font-weight:700}.kpi-l{font-weight:600}.kpi-s{color:var(--muted);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--ink);display:flex;flex-direction:column;border-top:4px solid var(--c,var(--line))}
.card .n{font-size:20px;font-weight:700}.card.on{outline:2px solid var(--c)}.card.clear{justify-content:center;align-items:center;color:var(--accent)}
.s-NEW{--c:var(--new)}.s-TEXT_SENT{--c:var(--sent)}.s-REPLIED{--c:var(--replied)}.s-BOOKED{--c:var(--booked)}
.s-NO_RESPONSE{--c:var(--nores)}.s-OPTED_OUT{--c:var(--opt)}.s-FAILED{--c:var(--fail)}.s-NO_CONSENT{--c:var(--nocon)}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;color:#fff;background:var(--c);white-space:nowrap}
.tablewrap{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}td.last{max-width:260px;color:var(--muted)}.dir{color:var(--ink)}td.empty{color:var(--muted);text-align:center;padding:30px}
@media (max-width:760px){thead{display:none}tr{display:block;border-bottom:1px solid var(--line);padding:8px 0}
td{display:flex;gap:10px;border:0;padding:3px 12px}td::before{content:attr(data-l);min-width:96px;color:var(--muted);font-size:12px}td.last{max-width:none}}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}.actions form{margin:0}
button{font:inherit;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}
.cols{display:grid;grid-template-columns:1fr 1.2fr;gap:14px;margin-bottom:14px}@media (max-width:760px){.cols{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.kpis,.cards,.tablewrap{padding:0;border:0;background:none}
.tablewrap{border:1px solid var(--line);background:var(--panel)}
dl{display:grid;grid-template-columns:130px 1fr;gap:6px 10px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.thread{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}.msg{max-width:85%}.msg.out{align-self:flex-end}
.bubble{padding:9px 12px;border-radius:14px;background:var(--bg);border:1px solid var(--line)}.msg.out .bubble{background:var(--accent);color:#fff;border-color:var(--accent)}
.meta{font-size:11px;color:var(--muted);margin-top:3px}.msg.out .meta{text-align:right}
.msg.out.unsent .bubble{background:transparent;color:var(--muted);border:1px dashed var(--line)}
.reply textarea{width:100%;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);margin-bottom:8px}
.muted{color:var(--muted)}.events{list-style:none;margin:0;padding:0}.events li{padding:4px 0;border-bottom:1px solid var(--line)}.events span{color:var(--muted);display:inline-block;min-width:120px}
`;

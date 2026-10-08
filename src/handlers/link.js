import { calendlyUrlFor, isBot } from '../links.js';
import { audit } from '../db.js';
import { text, safe } from '../http.js';

// GET /r/<code> — count the click and forward to the booking calendar.
// Never breaks: an unknown code still lands on the calendar.
export const handleLink = safe('link', async (deps, req, code) => {
  const { db, config } = deps;
  const { rows } = await db.query('select * from leads where link_code = $1', [String(code || '')]);
  const lead = rows[0];
  if (!lead) {
    if (!config.calendlyUrl) return text('Not found', 404);
    return Response.redirect(config.calendlyUrl, 302);
  }
  if (!isBot(req.headers.get('user-agent'))) {
    const { rows: upd } = await db.query(
      `update leads set link_clicks = link_clicks + 1, first_click_at = coalesce(first_click_at, $2)
       where id = $1 returning link_clicks`,
      [lead.id, deps.now()],
    );
    if (upd[0].link_clicks === 1) await audit(db, lead.id, 'calendar_link_clicked', {});
  }
  return new Response(null, {
    status: 302,
    headers: { Location: calendlyUrlFor(config, lead), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
});

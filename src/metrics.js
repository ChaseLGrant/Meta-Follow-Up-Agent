// The numbers that answer: "is the automation producing sales conversations?"
// Counts are by LEAD (family), within the chosen period of lead received date.

export async function getMetrics(db, since) {
  const { rows } = await db.query(
    `select
       count(*) filter (where lead_source <> 'calendly_direct')::int                      as total_leads,
       count(*) filter (where sms_consent)::int                                          as sms_eligible,
       count(*) filter (where first_text_sent_at is not null)::int                       as texted,
       count(*) filter (where first_delivered_at is not null)::int                       as delivered_leads,
       count(*) filter (where replied_at is not null and first_text_sent_at is not null)::int as replied,
       count(*) filter (where link_clicks > 0)::int                                      as clicked,
       count(*) filter (where booked_at is not null and lead_source <> 'calendly_direct')::int as booked,
       count(*) filter (where booked_at is not null and lead_source = 'calendly_direct')::int  as booked_direct,
       count(*) filter (where booking_status = 'SHOWED')::int                            as showed,
       count(*) filter (where booking_status = 'NO_SHOW')::int                           as no_show,
       count(*) filter (where closed_won)::int                                           as closed,
       count(*) filter (where do_not_text)::int                                          as opted_out
     from leads where received_at >= $1`,
    [since],
  );
  const { rows: msgRows } = await db.query(
    `select count(*) filter (where m.status = 'delivered')::int as texts_delivered,
            count(*) filter (where m.status in ('sent','delivered','simulated'))::int as texts_sent,
            count(*) filter (where m.status in ('failed','undelivered'))::int as texts_failed
     from messages m join leads l on l.id = m.lead_id
     where m.direction = 'out' and l.received_at >= $1`,
    [since],
  );
  const { rows: statusRows } = await db.query(
    `select status, count(*)::int as n from leads where received_at >= $1 group by status`, [since]);

  const m = { ...rows[0], ...msgRows[0] };
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  // Response rate is measured against texts that reached the phone (delivery receipts); before
  // Twilio is live (dry run) it falls back to texts sent.
  const reached = m.delivered_leads || m.texted;
  m.response_rate = pct(m.replied, reached);
  m.click_rate = pct(m.clicked, reached);
  m.lead_to_booked_rate = pct(m.booked, m.total_leads);
  m.texted_to_booked_rate = pct(m.booked, m.texted);
  m.show_rate = pct(m.showed, m.showed + m.no_show);
  m.close_rate = pct(m.closed, m.showed);
  m.by_status = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));
  return m;
}

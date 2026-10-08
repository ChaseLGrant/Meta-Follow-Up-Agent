// A lead's dashboard status is DERIVED from facts we record, so it can never drift out of sync.
// Order matters: the first rule that matches wins.

export const STATUSES = ['NEW', 'NO_CONSENT', 'TEXT_SENT', 'REPLIED', 'BOOKED', 'NO_RESPONSE', 'OPTED_OUT', 'FAILED'];

export function deriveStatus(l) {
  if (l.do_not_text) return 'OPTED_OUT';
  if (['BOOKED', 'SHOWED', 'NO_SHOW'].includes(l.booking_status)) return 'BOOKED';
  if (l.replied_at) return 'REPLIED';
  if (l.sms_failed) return 'FAILED';
  if (!l.sms_consent || !l.phone_e164) return 'NO_CONSENT';
  if (l.sequence_completed_at) return 'NO_RESPONSE';
  if (l.first_text_sent_at) return 'TEXT_SENT';
  return 'NEW';
}

export async function refreshStatus(db, leadId) {
  const { rows } = await db.query('select * from leads where id = $1', [leadId]);
  if (!rows[0]) return null;
  const status = deriveStatus(rows[0]);
  await db.query('update leads set status = $2, updated_at = now() where id = $1', [leadId, status]);
  return { ...rows[0], status };
}

export async function cancelPendingSequence(db, leadId, reason) {
  const { rows } = await db.query(
    `update messages set status = 'canceled', error_message = $2
     where lead_id = $1 and status = 'scheduled' and kind in ('initial', 'fu1', 'fu2')
     returning kind`,
    [leadId, reason],
  );
  return rows.map((r) => r.kind);
}

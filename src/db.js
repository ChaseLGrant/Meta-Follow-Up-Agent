import pg from 'pg';

// Every module talks to the database through `db.query(text, params) -> { rows }`.
// Production uses a pg Pool (Supabase); tests pass in an in-memory Postgres (PGlite).

let pool;

export function getDb(config) {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 3,
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function audit(db, leadId, type, detail = {}) {
  await db.query('insert into lead_events (lead_id, type, detail) values ($1, $2, $3)', [
    leadId,
    type,
    JSON.stringify(detail),
  ]);
}

// Returns true the first time an external event id is seen, false for repeats.
export async function firstTimeSeen(db, source, externalId) {
  const { rows } = await db.query(
    `insert into webhook_events (source, external_id) values ($1, $2)
     on conflict do nothing returning external_id`,
    [source, String(externalId)],
  );
  return rows.length === 1;
}

export async function forgetEvent(db, source, externalId) {
  await db.query('delete from webhook_events where source = $1 and external_id = $2', [source, String(externalId)]);
}

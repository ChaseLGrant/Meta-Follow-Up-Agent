// Creates/updates the database tables. Safe to run more than once.
//   DATABASE_URL="postgresql://..." npm run db:schema
import fs from 'node:fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL first (Supabase → Project Settings → Database → Connection string).');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url, ssl: /localhost/.test(url) ? false : { rejectUnauthorized: false } });
await client.connect();
await client.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await client.end();
console.log('Schema applied.');

// Write / read / delete smoke test with a synthetic key (never production data).
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(url);
const k = `smoke:${Date.now()}`;
await sql.query("INSERT INTO cache_entries (key, value, fetched_at, expires_at) VALUES ($1, $2::jsonb, now(), now() + interval '1 minute')", [k, JSON.stringify({ ok: true })]);
const read = await sql.query("SELECT value FROM cache_entries WHERE key = $1", [k]);
const del = await sql.query("DELETE FROM cache_entries WHERE key = $1 RETURNING key", [k]);
const ok = read.length === 1 && read[0].value.ok === true && del.length === 1;
console.log(ok ? "smoke test: write/read/delete OK" : "smoke test: FAILED");
process.exit(ok ? 0 : 1);

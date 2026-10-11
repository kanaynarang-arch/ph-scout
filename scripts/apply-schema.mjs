// Applies db/schema.sql (idempotent). Reads DATABASE_URL from the environment; never prints it.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = neon(url);
const statements = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
  .split(";")
  .map((s) => s.replace(/--.*$/gm, "").trim())
  .filter(Boolean);
for (const s of statements) await sql.query(s);
const t = await sql.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('cache_entries','launch_seen','notify_control','notify_log') ORDER BY 1");
console.log("schema applied; tables:", t.map((r) => r.table_name).join(", "));

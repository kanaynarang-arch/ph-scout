import { neon } from "@neondatabase/serverless";
import { DB_TIMEOUT_MS } from "./config";

// Neon over the HTTP driver. DATABASE_URL is the pooled connection string, server-side only.
// Parameterised queries only. Every call has a hard timeout.

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export class DbError extends Error {}

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new DbError("DATABASE_URL not set");
  try {
    const sql = neon(url, { fetchOptions: { signal: AbortSignal.timeout(DB_TIMEOUT_MS) } });
    const rows = await sql.query(text, params);
    return rows as T[];
  } catch (e) {
    throw new DbError(e instanceof Error ? e.message.slice(0, 120) : "database error");
  }
}

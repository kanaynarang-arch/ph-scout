import { CACHE_NS, LOCK_TTL_MS, PURGE_GRACE_MS, PURGE_LIMIT } from "./config";
import { dbConfigured, query } from "./db";

// Neon-backed cache (no in-memory layer: with no database every run fetches live).
// A database error is NOT an empty cache: the caller is told the DB is unavailable.

export interface Entry<T> {
  value: T;
  fetchedAt: string; // ISO
  expiresAt: string; // ISO
}

export const key = (...parts: string[]) => `${CACHE_NS}:${parts.join(":")}`;

const isFresh = (e: Entry<unknown>, now = Date.now()) => Date.parse(e.expiresAt) > now;

type Validate<T> = (v: unknown) => v is T;

interface Row {
  key: string;
  value: unknown;
  fetched_at: string;
  expires_at: string;
}

export interface ReadResult<T> {
  entries: Map<string, Entry<T>>;
  dbError: boolean;
}

/** Read many keys from Neon. Entries may be expired (stale); the caller decides. */
export async function readMany<T>(keys: string[], validate: Validate<T>): Promise<ReadResult<T>> {
  const entries = new Map<string, Entry<T>>();
  if (!keys.length || !dbConfigured()) return { entries, dbError: false };
  try {
    const rows = await query<Row>(
      "SELECT key, value, fetched_at, expires_at FROM cache_entries WHERE key = ANY($1::text[])",
      [keys],
    );
    for (const r of rows) {
      if (!validate(r.value)) continue; // JSON validated on read
      entries.set(r.key, {
        value: r.value,
        fetchedAt: new Date(r.fetched_at).toISOString(),
        expiresAt: new Date(r.expires_at).toISOString(),
      });
    }
    return { entries, dbError: false };
  } catch {
    return { entries, dbError: true };
  }
}

export async function writeMany<T>(items: { key: string; value: T; ttlMs: number }[], fetchedAt = new Date()): Promise<boolean> {
  if (!items.length) return true;
  if (!dbConfigured()) return false;
  try {
    const keys = items.map((i) => i.key);
    const values = items.map((i) => JSON.stringify(i.value));
    const expires = items.map((i) => new Date(fetchedAt.getTime() + i.ttlMs).toISOString());
    await query(
      `INSERT INTO cache_entries (key, value, fetched_at, expires_at)
       SELECT k, v::jsonb, $4::timestamptz, e::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(k, v, e)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
      [keys, values, expires, fetchedAt.toISOString()],
    );
    return true;
  } catch {
    return false;
  }
}

// ---- locks (short-lived rows, atomic insert) ----
const memoryLocks = new Map<string, number>();

/** Try to take lock:<name>. Returns true when acquired. Works across instances when Neon is up. */
export async function acquireLock(name: string, ttlMs = LOCK_TTL_MS): Promise<boolean> {
  const k = `lock:${name}`;
  const now = Date.now();
  if (dbConfigured()) {
    try {
      const rows = await query(
        `INSERT INTO cache_entries (key, value, fetched_at, expires_at)
         VALUES ($1, 'true'::jsonb, now(), now() + ($2::int * interval '1 millisecond'))
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at
           WHERE cache_entries.expires_at < now()
         RETURNING key`,
        [k, ttlMs],
      );
      return rows.length > 0;
    } catch {
      // DB down: fall through to the in-instance lock
    }
  }
  const until = memoryLocks.get(k) ?? 0;
  if (until > now) return false;
  memoryLocks.set(k, now + ttlMs);
  return true;
}

export async function releaseLock(name: string): Promise<void> {
  const k = `lock:${name}`;
  memoryLocks.delete(k);
  if (!dbConfigured()) return;
  try {
    await query("DELETE FROM cache_entries WHERE key = $1", [k]);
  } catch {
    /* lock expires by itself after 60 seconds */
  }
}

/** When does a lock row expire? null if unknown or not held. */
export async function lockExpiry(name: string): Promise<number | null> {
  const k = `lock:${name}`;
  const mem = memoryLocks.get(k);
  if (dbConfigured()) {
    try {
      const rows = await query<{ expires_at: string }>(
        "SELECT expires_at FROM cache_entries WHERE key = $1 AND expires_at > now()",
        [k],
      );
      if (rows[0]) return Date.parse(rows[0].expires_at);
      return null;
    } catch {
      /* fall through */
    }
  }
  return mem && mem > Date.now() ? mem : null;
}

export type CacheStatus = "fresh" | "refreshed" | "stale";

export interface Resolved<T> {
  value: T;
  fetchedAt: string;
  status: CacheStatus; // fresh = unexpired saved copy, refreshed = fetched just now, stale = refresh failed, old copy served
  dbError: boolean; // the database could not be read (live data was used instead)
}

/**
 * Fresh entry -> return it. Expired (or forced) -> refresh under a lock.
 * If the refresh fails, serve the stale entry (status "stale"). Nothing usable -> throws.
 */
export async function getOrRefresh<T>(opts: {
  key: string;
  ttlMs: number;
  validate: Validate<T>;
  fetcher: () => Promise<T>;
  force?: boolean;
  lockName: string;
}): Promise<Resolved<T>> {
  const { key: k, ttlMs, validate, fetcher, force, lockName } = opts;
  const read = await readMany<T>([k], validate);
  const entry = read.entries.get(k);
  if (entry && isFresh(entry) && !force) return { value: entry.value, fetchedAt: entry.fetchedAt, status: "fresh", dbError: read.dbError };

  const gotLock = read.dbError ? true : await acquireLock(lockName);
  if (!gotLock) {
    // Someone else is refetching. Serve the stale copy, or wait briefly for theirs.
    if (entry) return { value: entry.value, fetchedAt: entry.fetchedAt, status: "stale", dbError: read.dbError };
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const again = await readMany<T>([k], validate);
      const e = again.entries.get(k);
      if (e && isFresh(e)) return { value: e.value, fetchedAt: e.fetchedAt, status: "fresh", dbError: read.dbError };
    }
  }
  try {
    const value = await fetcher();
    const now = new Date();
    await writeMany([{ key: k, value, ttlMs }], now);
    return { value, fetchedAt: now.toISOString(), status: "refreshed", dbError: read.dbError };
  } catch (err) {
    if (entry) return { value: entry.value, fetchedAt: entry.fetchedAt, status: "stale", dbError: read.dbError };
    throw err;
  } finally {
    if (gotLock && !read.dbError) await releaseLock(lockName);
  }
}

/** Delete expired rows beyond the grace period (bounded). Returns how many were removed. */
export async function purgeExpired(): Promise<number> {
  if (!dbConfigured()) return 0;
  try {
    const rows = await query(
      `DELETE FROM cache_entries WHERE key IN (
         SELECT key FROM cache_entries
         WHERE expires_at < now() - ($1::int * interval '1 millisecond') LIMIT $2
       ) RETURNING key`,
      [PURGE_GRACE_MS, PURGE_LIMIT],
    );
    return rows.length;
  } catch {
    return 0;
  }
}

/** Test helper: forget the in-instance locks. */
export function _clearLocks() {
  memoryLocks.clear();
}

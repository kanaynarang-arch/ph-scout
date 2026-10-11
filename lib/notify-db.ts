import { NOTIFY_COOLDOWN_SECONDS, NOTIFY_DAILY_CAP } from "./config";
import { dbConfigured, query } from "./db";
import type { ClaimResult, Limiter } from "./notify";

// Neon-backed limits for the auto-send. "Day" means the IST day (resets at midnight IST). One control row per cache namespace (production = "v1"), so tests with
// another namespace never touch the live limits. The claim is ONE conditional statement: no check-then-update.

export const CLAIM_SQL = `
INSERT INTO notify_control AS c (key, last_sent_at, day, day_count)
VALUES ($1, now(), (now() AT TIME ZONE 'Asia/Kolkata')::date, 1)
ON CONFLICT (key) DO UPDATE SET
  last_sent_at = now(),
  day = (now() AT TIME ZONE 'Asia/Kolkata')::date,
  day_count = CASE WHEN c.day = (now() AT TIME ZONE 'Asia/Kolkata')::date THEN c.day_count + 1 ELSE 1 END
WHERE (c.last_sent_at IS NULL OR c.last_sent_at <= now() - ($2::int * interval '1 second'))
  AND (c.day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kolkata')::date OR c.day_count < $3::int)
RETURNING 1 AS claimed`;

const STATE_SQL = `
SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (last_sent_at + ($2::int * interval '1 second') - now()))))::int AS cooldown_left,
       (day = (now() AT TIME ZONE 'Asia/Kolkata')::date AND day_count >= $3::int) AS capped,
       CEIL(EXTRACT(EPOCH FROM (((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp - (now() AT TIME ZONE 'Asia/Kolkata'))))::int AS to_midnight
FROM notify_control WHERE key = $1`;

export function neonLimiter(key: string): Limiter {
  return {
    async claim(): Promise<ClaimResult> {
      if (!dbConfigured()) return { ok: false, reason: "unavailable" };
      try {
        const rows = await query<{ claimed: number }>(CLAIM_SQL, [key, NOTIFY_COOLDOWN_SECONDS, NOTIFY_DAILY_CAP]);
        if (rows.length === 1) return { ok: true };
        // Blocked. Read the state only to tell Kavya why (not used for the decision above).
        const s = await query<{ cooldown_left: number; capped: boolean; to_midnight: number }>(STATE_SQL, [key, NOTIFY_COOLDOWN_SECONDS, NOTIFY_DAILY_CAP]);
        if (s[0]?.capped) return { ok: false, reason: "daily_cap", retryInSeconds: s[0].to_midnight };
        return { ok: false, reason: "cooldown", retryInSeconds: Math.max(1, s[0]?.cooldown_left ?? NOTIFY_COOLDOWN_SECONDS) };
      } catch {
        return { ok: false, reason: "unavailable" }; // database problem: fail closed
      }
    },
  };
}

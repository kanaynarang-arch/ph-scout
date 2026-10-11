import { NOTIFY_COOLDOWN_SECONDS } from "./config";
import { dbConfigured, query } from "./db";
import type { ClaimResult, Limiter } from "./notify";

// Neon-backed send limit (one copy per 5 minutes). One control row per cache namespace (production = "v1"), so tests with
// another namespace never touch the live limit. The claim is ONE conditional statement: no check-then-update.

export const CLAIM_SQL = `
INSERT INTO notify_control AS c (key, last_sent_at)
VALUES ($1, now())
ON CONFLICT (key) DO UPDATE SET last_sent_at = now()
WHERE c.last_sent_at IS NULL OR c.last_sent_at <= now() - ($2::int * interval '1 second')
RETURNING 1 AS claimed`;

const STATE_SQL = `
SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (last_sent_at + ($2::int * interval '1 second') - now()))))::int AS cooldown_left
FROM notify_control WHERE key = $1`;

export function neonLimiter(key: string): Limiter {
  return {
    async claim(): Promise<ClaimResult> {
      if (!dbConfigured()) return { ok: false, reason: "unavailable" };
      try {
        const rows = await query<{ claimed: number }>(CLAIM_SQL, [key, NOTIFY_COOLDOWN_SECONDS]);
        if (rows.length === 1) return { ok: true };
        // Blocked. Read the state only to tell Kavya how long to wait (not used for the decision above).
        const s = await query<{ cooldown_left: number }>(STATE_SQL, [key, NOTIFY_COOLDOWN_SECONDS]);
        return { ok: false, reason: "cooldown", retryInSeconds: Math.max(1, s[0]?.cooldown_left ?? NOTIFY_COOLDOWN_SECONDS) };
      } catch {
        return { ok: false, reason: "unavailable" }; // database problem: fail closed
      }
    },
  };
}

// Proves the send limit is atomic against the real Neon database, using a THROWAWAY control key.
// Never touches the production key ("v1") and never sends anything.
import { neon } from "@neondatabase/serverless";
import { NOTIFY_COOLDOWN_SECONDS, NOTIFY_DAILY_CAP } from "../lib/config";
import { neonLimiter } from "../lib/notify-db";

const key = `atomic-test-${Date.now()}`;
const sql = neon(process.env.DATABASE_URL!);
const limiter = neonLimiter(key);
let failed = false;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed = true;
};

// 1. Twelve concurrent claims: exactly one may win.
const results = await Promise.all(Array.from({ length: 12 }, () => limiter.claim()));
const winners = results.filter((r) => r.ok);
check("12 concurrent claims -> exactly 1 wins", winners.length === 1, `(winners=${winners.length})`);
const blocked = results.filter((r) => !r.ok) as Extract<(typeof results)[number], { ok: false }>[];
check("the other 11 are told 'cooldown' with a countdown", blocked.length === 11 && blocked.every((b) => b.reason === "cooldown" && (b.retryInSeconds ?? 0) > 0 && (b.retryInSeconds ?? 0) <= NOTIFY_COOLDOWN_SECONDS));

// 2. Releasing the winning claim gives it back; the next claim succeeds, then is blocked again.
const win = winners[0] as Extract<(typeof results)[number], { ok: true }>;
await limiter.release(win.token);
const after = await limiter.claim();
check("after release the next claim succeeds", after.ok);
const again = await limiter.claim();
check("and a claim right after that is blocked", !again.ok && again.reason === "cooldown");
if (after.ok) {
  // a stale token (already replaced by a newer claim) must not release anything
  await limiter.release(win.token);
  const stillBlocked = await limiter.claim();
  check("a stale release does not reopen the cooldown", !stillBlocked.ok);
}

// 3. Daily cap: push the row to 9 sends, backdate the cooldown, then allow exactly one more.
await sql.query("UPDATE notify_control SET day_count = $2, last_sent_at = now() - interval '10 minutes' WHERE key = $1", [key, NOTIFY_DAILY_CAP - 1]);
const tenth = await limiter.claim();
check(`claim #${NOTIFY_DAILY_CAP} of the day succeeds`, tenth.ok);
await sql.query("UPDATE notify_control SET last_sent_at = now() - interval '10 minutes' WHERE key = $1", [key]);
const eleventh = await limiter.claim();
check(`claim #${NOTIFY_DAILY_CAP + 1} is refused as 'daily_cap'`, !eleventh.ok && eleventh.reason === "daily_cap", eleventh.ok ? "" : `(retry in ${eleventh.retryInSeconds}s)`);

// 4. A new IST day resets the count.
await sql.query("UPDATE notify_control SET day = day - 1, last_sent_at = now() - interval '10 minutes' WHERE key = $1", [key]);
const nextDay = await limiter.claim();
check("on a new IST day the count resets", nextDay.ok);

// 5. The log accepts a row and holds no text, tokens or addresses (only the columns below).
await limiter.log({ status: "blocked", telegram: null, email: null, rows: 0 });
const cols = await sql.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'notify_log' ORDER BY ordinal_position");
check("log table has only time/key/status/per-channel result/row count", cols.map((c) => c.column_name).join(",") === "id,at,key,status,telegram,email,row_count", `(${cols.map((c) => c.column_name).join(",")})`);

// cleanup of THIS script's throwaway rows only
const d1 = await sql.query("DELETE FROM notify_control WHERE key = $1 RETURNING key", [key]);
const d2 = await sql.query("DELETE FROM notify_log WHERE key = $1 RETURNING id", [key]);
console.log(`cleanup: removed ${d1.length} control row and ${d2.length} log row (throwaway key)`);
process.exit(failed ? 1 : 0);

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
check("12 concurrent claims -> exactly 1 wins", results.filter((r) => r.ok).length === 1);
const blocked = results.filter((r) => !r.ok) as Extract<(typeof results)[number], { ok: false }>[];
check("the other 11 are told 'cooldown' with a countdown", blocked.length === 11 && blocked.every((b) => b.reason === "cooldown" && (b.retryInSeconds ?? 0) > 0 && (b.retryInSeconds ?? 0) <= NOTIFY_COOLDOWN_SECONDS));
const again = await limiter.claim();
check("a claim right afterwards is still blocked (a taken slot is never given back)", !again.ok && again.reason === "cooldown");

// 2. Daily cap: push the row to one below the cap, backdate the cooldown, then allow exactly one more.
await sql.query("UPDATE notify_control SET day_count = $2, last_sent_at = now() - interval '10 minutes' WHERE key = $1", [key, NOTIFY_DAILY_CAP - 1]);
check(`claim #${NOTIFY_DAILY_CAP} of the day succeeds`, (await limiter.claim()).ok);
await sql.query("UPDATE notify_control SET last_sent_at = now() - interval '10 minutes' WHERE key = $1", [key]);
const over = await limiter.claim();
check(`claim #${NOTIFY_DAILY_CAP + 1} is refused as 'daily_cap'`, !over.ok && over.reason === "daily_cap", over.ok ? "" : `(retry in ${over.retryInSeconds}s)`);

// 3. A new IST day resets the count.
await sql.query("UPDATE notify_control SET day = day - 1, last_sent_at = now() - interval '10 minutes' WHERE key = $1", [key]);
check("on a new IST day the count resets", (await limiter.claim()).ok);

const d = await sql.query("DELETE FROM notify_control WHERE key = $1 RETURNING key", [key]);
console.log(`cleanup: removed ${d.length} control row (throwaway key)`);
process.exit(failed ? 1 : 0);

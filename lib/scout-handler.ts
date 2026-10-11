import { CACHE_NS } from "./config";
import { isRealGenerate, maybeNotify, type Limiter } from "./notify";
import { neonLimiter } from "./notify-db";
import { runScout } from "./pipeline";
import type { Notification, ScoutResponse } from "./types";

export interface ScoutHandlerDeps {
  run?: typeof runScout;
  limiter?: () => Limiter;
  schedule: (task: () => Promise<void>) => void;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/**
 * POST /api/scout. The ONLY thing read from the request body is `refresh === true` (Refresh now).
 * Every other field is ignored: the client cannot supply text, recipients or a "please send" flag.
 */
export async function handleScout(req: Request, deps: ScoutHandlerDeps): Promise<ScoutResponse & { notification: Notification }> {
  let refresh = false;
  try {
    const body = await req.json();
    refresh = body?.refresh === true;
  } catch {
    /* no body = plain Generate */
  }
  const data = await (deps.run ?? runScout)({ refresh });
  const notification = await maybeNotify({
    generate: isRealGenerate(req.headers, refresh),
    data,
    env: deps.env ?? process.env,
    limiter: deps.limiter ?? (() => neonLimiter(CACHE_NS)),
    schedule: deps.schedule,
    fetchFn: deps.fetchFn,
    now: deps.now,
  });
  return { ...data, notification };
}

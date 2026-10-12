import { parseExtras } from "./categories";
import { CACHE_NS } from "./config";
import { isRealGenerate, maybeNotify, parseChannels, type Channel, type Limiter } from "./notify";
import { neonLimiter } from "./notify-db";
import { isBrowserSameOrigin } from "./origin";
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
 * POST /api/scout. Only three things are read from the request body: `refresh === true` (Refresh now), `extras`, a list of
 * optional category ids that is checked against a fixed menu (unknown ids dropped, at most MAX_EXTRAS), and `channels`, the
 * copy-to-Kavya channels the visitor left switched on (parseChannels: it can only switch channels off). The last two are
 * honoured only for a request that comes from a browser on this site. Every other field is ignored: the client cannot supply text,
 * topic names, recipients or a "please send" flag.
 */
export async function handleScout(req: Request, deps: ScoutHandlerDeps): Promise<ScoutResponse & { notification: Notification }> {
  let refresh = false;
  let extras: ReturnType<typeof parseExtras> = [];
  let wanted: Channel[] | undefined;
  try {
    const body = await req.json();
    refresh = body?.refresh === true;
    if (isBrowserSameOrigin(req.headers)) {
      extras = parseExtras(body?.extras);
      wanted = parseChannels(body?.channels);
    }
  } catch {
    /* no body = plain Generate */
  }
  const data = await (deps.run ?? runScout)({ refresh, extras });
  const notification = await maybeNotify({
    generate: isRealGenerate(req.headers, refresh),
    data,
    env: deps.env ?? process.env,
    limiter: deps.limiter ?? (() => neonLimiter(CACHE_NS)),
    schedule: deps.schedule,
    fetchFn: deps.fetchFn,
    now: deps.now,
    wanted,
  });
  return { ...data, notification };
}

import { parseExtras } from "./categories";
import { isBrowserSameOrigin } from "./origin";
import { sendNow, type Channel, type Limiter } from "./notify";
import { runScout } from "./pipeline";
import type { Notification, ScoutResponse } from "./types";

export interface SendHandlerDeps {
  run?: (opts: { extras: ReturnType<typeof parseExtras> }) => Promise<ScoutResponse>;
  limiterFor: (channel: Channel) => Limiter;
  schedule: (task: () => Promise<void>) => void;
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/**
 * POST /api/send: Kavya clicked "Send to Telegram" or "Send to email" on the dashboard. Only two things are read from the body:
 * `channel` ("telegram" or "email") and `extras` (the optional categories on screen, checked against the fixed menu). The server
 * builds the list itself (from its saved copies when fresh) and sends it to the configured recipient; the text, the recipient and
 * the list never come from the page. Only requests that carry the browser headers are accepted (a convenience boundary, like
 * /api/draft); the per-channel limit of one send per 5 minutes is the real protection.
 */
export async function handleSend(req: Request, deps: SendHandlerDeps): Promise<{ status: number; body: { notification?: Notification; error?: string } }> {
  if (!isBrowserSameOrigin(req.headers)) return { status: 403, body: { error: "Sending is only available from the page." } };
  let channel: unknown;
  let extras: ReturnType<typeof parseExtras> = [];
  try {
    const text = await req.text();
    if (text.length > 500) return { status: 400, body: { error: "Bad request." } };
    const parsed = JSON.parse(text) as { channel?: unknown; extras?: unknown };
    channel = parsed.channel;
    extras = parseExtras(parsed.extras);
  } catch {
    return { status: 400, body: { error: "Bad request." } };
  }
  if (channel !== "telegram" && channel !== "email") return { status: 400, body: { error: "Bad request." } };
  let data: ScoutResponse;
  try {
    data = await (deps.run ?? ((o) => runScout(o)))({ extras });
  } catch {
    return { status: 500, body: { error: "Could not build the list to send. Please try again." } };
  }
  const notification = await sendNow({ channel, data, env: deps.env ?? process.env, limiterFor: deps.limiterFor, schedule: deps.schedule, fetchFn: deps.fetchFn, now: deps.now });
  return { status: 200, body: { notification } };
}

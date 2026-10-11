import {
  APP_PUBLIC_URL,
  NOTIFY_COOLDOWN_SECONDS,
  NOTIFY_DAILY_CAP,
  NOTIFY_TIMEOUT_MS,
  NOTIFY_TOP_N,
  TELEGRAM_PART_LIMIT,
} from "./config";
import type { Notification, ScoredLaunch, ScoutResponse } from "./types";
import { NO_ANGLE } from "./verify";

// Sends a copy of the list that the server just built to Kavya's OWN Telegram and email.
// Triggered only by a real Generate. The client supplies no text and no recipients.
// Recipients and keys come only from server env vars and never leave this module.

type Channel = "telegram" | "email";

// ---------------------------------------------------------------- config / kill switches
export interface NotifyConfig {
  enabled: boolean;
  telegram: { token: string; chatId: string } | null;
  email: { apiKey: string; to: string } | null;
  channels: Channel[];
}

export function notifyConfig(env: Record<string, string | undefined>): NotifyConfig {
  const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : null;
  const email = env.RESEND_API_KEY && env.NOTIFY_EMAIL ? { apiKey: env.RESEND_API_KEY, to: env.NOTIFY_EMAIL } : null;
  const channels: Channel[] = [...(telegram ? (["telegram"] as const) : []), ...(email ? (["email"] as const) : [])];
  return { enabled: env.NOTIFICATIONS_ENABLED === "true" && channels.length > 0, telegram, email, channels };
}

// ---------------------------------------------------------------- is this a real Generate?
/**
 * True only for the Generate button: not Refresh now, and the request must come from a browser page of this
 * app (Sec-Fetch-Site: same-origin, or an Origin that matches the Host). Scripts, curl and other sites do not
 * send these, so they can never trigger a message. A client-supplied "please send" field does not exist.
 */
export function isRealGenerate(headers: Headers, refresh: boolean): boolean {
  if (refresh) return false;
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- message building
const FIT_LABEL: Record<ScoredLaunch["ai"]["fit"], string> = {
  strong: "Strong fit",
  possible: "Possible fit",
  weak: "Weak fit",
  competitor: "Likely competitor",
  unrated: "Not rated",
};

export function clean(value: string, max: number): string {
  const t = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Only Product Hunt launch links are ever included. */
export function safeLink(url: string): string {
  return /^https:\/\/www\.producthunt\.com\/[^\s<>"']*$/.test(url) ? url : "";
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function founderText(f: ScoredLaunch["founders"]): string {
  if (f.names.length) return clean(f.names.join("; ") + (f.hiddenCount > 0 ? ` (+${f.hiddenCount} hidden)` : ""), 100);
  if (f.hunter) return clean(`${f.hunter} (hunter, may not be the founder)`, 100);
  return "not shown";
}

// Times in the message are shown in IST (UTC+5:30, no daylight saving), the way Kavya reads them.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
/** The IST calendar day (YYYY-MM-DD): the daily send limit resets at midnight IST. */
export const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
export const secondsToIstMidnight = (d: Date) => {
  const shifted = d.getTime() + IST_OFFSET_MS;
  return Math.ceil((Math.floor(shifted / 86_400_000 + 1) * 86_400_000 - shifted) / 1000);
};
export const ist = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") + " IST";

interface Entry {
  title: string;
  founders: string;
  facts: string;
  angle: string;
  link: string;
}

function entryOf(r: ScoredLaunch, rank: number): Entry {
  const angleMissing = r.ai.fit === "unrated" || r.ai.angle === NO_ANGLE || !r.ai.angle;
  return {
    title: `#${rank} ${clean(r.name, 80)}`,
    founders: founderText(r.founders),
    facts: [
      `score ${r.score.toFixed(1)}${r.provisional ? " (provisional)" : ""}`,
      `${r.votesCount} upvotes`,
      `${r.makerComments === null ? "maker comments not counted" : `${r.makerComments} maker comments`}`,
      `day ${r.daysSinceLaunch}`,
      FIT_LABEL[r.ai.fit],
    ].join(" · "),
    angle: angleMissing ? "angle unavailable" : `AI suggestion: ${clean(r.ai.angle, 300)}`,
    link: safeLink(r.url),
  };
}

export interface BuiltMessage {
  telegramParts: string[];
  subject: string;
  text: string;
  html: string;
  rows: number;
}

export function buildMessage(data: ScoutResponse, clickedAt: Date, appUrl = APP_PUBLIC_URL): BuiltMessage {
  const top = data.ranked.slice(0, NOTIFY_TOP_N);
  const entries = top.map((r, i) => entryOf(r, i + 1));
  const header = `PH Scout: your list (Generate clicked ${ist(clickedAt)})`;
  const source = `Source: ${data.source}${data.source === "CACHED" ? " (saved copy)" : ""}, fetched ${ist(new Date(data.fetchedAt))}`;
  const footer = [`Open the app: ${appUrl}`, "For you only. Nothing was sent to anyone else."];

  const entryText = (e: Entry) => [e.title, `Founders: ${e.founders}`, e.facts, e.angle, e.link].filter(Boolean).join("\n");
  const body = entries.map(entryText);
  const text = [header, source, "", ...body.flatMap((b) => [b, ""]), ...footer].join("\n");

  // Telegram: plain text (no parse_mode), split at entry boundaries under the limit.
  const telegramParts: string[] = [];
  let current = [header, source, ""].join("\n");
  const flush = () => {
    if (current.trim()) telegramParts.push(current.trimEnd());
    current = "";
  };
  for (const b of [...body, footer.join("\n")]) {
    const piece = b.length > TELEGRAM_PART_LIMIT ? b.slice(0, TELEGRAM_PART_LIMIT - 1) + "…" : b;
    if (current && (current + "\n\n" + piece).length > TELEGRAM_PART_LIMIT) flush();
    current = current ? current + "\n\n" + piece : piece;
  }
  flush();
  const parts = telegramParts.length > 1 ? telegramParts.map((p, i) => `${p}\n\n(part ${i + 1} of ${telegramParts.length})`) : telegramParts;

  const li = (e: Entry) =>
    `<li><strong>${escapeHtml(e.title)}</strong><br>Founders: ${escapeHtml(e.founders)}<br>${escapeHtml(e.facts)}<br>${escapeHtml(e.angle)}` +
    (e.link ? `<br><a href="${escapeHtml(e.link)}">${escapeHtml(e.link)}</a>` : "") +
    "</li>";
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45">` +
    `<h2 style="font-size:17px">${escapeHtml(header)}</h2><p>${escapeHtml(source)}</p><ol>${entries.map(li).join("")}</ol>` +
    `<p>Open the app: <a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a><br>${escapeHtml(footer[1])}</p></div>`;

  return { telegramParts: parts, subject: `PH Scout: top ${entries.length} launches (${ist(clickedAt)})`, text, html, rows: entries.length };
}

// ---------------------------------------------------------------- delivery (a channel counts as sent only when the provider confirms)
type FetchFn = typeof fetch;

async function post(fetchFn: FetchFn, url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  } catch {
    return null; // timeout or network error
  }
}

/** True only when Telegram answers ok:true. Plain text, no parse_mode. */
export async function sendTelegram(cfg: NonNullable<NotifyConfig["telegram"]>, parts: string[], fetchFn: FetchFn): Promise<boolean> {
  let sentAny = false;
  for (const text of parts) {
    const r = await post(fetchFn, `https://api.telegram.org/bot${cfg.token}/sendMessage`, {}, { chat_id: cfg.chatId, text, disable_web_page_preview: true });
    if (r && r.status === 200 && (r.json as { ok?: boolean } | null)?.ok === true) sentAny = true;
    else break;
  }
  return sentAny;
}

/** True only when Resend returns an id. */
export async function sendEmail(cfg: NonNullable<NotifyConfig["email"]>, msg: BuiltMessage, fetchFn: FetchFn): Promise<boolean> {
  const r = await post(
    fetchFn,
    "https://api.resend.com/emails",
    { Authorization: `Bearer ${cfg.apiKey}` },
    { from: "PH Scout <onboarding@resend.dev>", to: [cfg.to], subject: msg.subject, text: msg.text, html: msg.html },
  );
  return !!r && r.status >= 200 && r.status < 300 && typeof (r.json as { id?: unknown } | null)?.id === "string";
}

// ---------------------------------------------------------------- limiter (atomic claim)
export type ClaimResult = { ok: true } | { ok: false; reason: "cooldown" | "daily_cap" | "unavailable"; retryInSeconds?: number };

export interface Limiter {
  /** Atomically takes one send slot (1 per 5 minutes, 10 per IST day). A taken slot is never given back. */
  claim(): Promise<ClaimResult>;
}

/** In-memory limiter with the same rules as the Neon one. Used by tests; the claim section is synchronous (atomic). */
export function memoryLimiter(clock: () => Date): Limiter {
  let last: number | null = null;
  let day = "";
  let count = 0;
  return {
    async claim() {
      const now = clock().getTime();
      const d = istDay(clock());
      const dayCount = day === d ? count : 0;
      if (dayCount >= NOTIFY_DAILY_CAP) return { ok: false, reason: "daily_cap", retryInSeconds: secondsToIstMidnight(clock()) };
      if (last !== null && now - last < NOTIFY_COOLDOWN_SECONDS * 1000) {
        return { ok: false, reason: "cooldown", retryInSeconds: Math.ceil((last + NOTIFY_COOLDOWN_SECONDS * 1000 - now) / 1000) };
      }
      last = now;
      day = d;
      count = dayCount + 1;
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------- orchestration
export interface NotifyDeps {
  generate: boolean; // result of isRealGenerate()
  data: ScoutResponse;
  env: Record<string, string | undefined>;
  limiter: () => Limiter;
  schedule: (task: () => Promise<void>) => void; // runs after the response is sent (Next's after())
  fetchFn?: FetchFn;
  now?: () => Date;
}

/**
 * Decides synchronously whether a copy is sent, then delivers in the background. Never throws and never
 * changes the list. Status is returned to the page; nothing secret is in it.
 */
export async function maybeNotify(d: NotifyDeps): Promise<Notification> {
  try {
    if (!d.generate) return { status: "skipped" };
    const cfg = notifyConfig(d.env);
    if (!cfg.enabled) return { status: "off" };
    if (d.data.source === "SAMPLE") return { status: "skipped_sample", channels: cfg.channels };
    if (d.data.ranked.length === 0) return { status: "skipped", channels: cfg.channels };

    const claim = await d.limiter().claim();
    if (!claim.ok) {
      if (claim.reason === "unavailable") return { status: "off" }; // cannot enforce the limits: send nothing
      return { status: claim.reason, retryInSeconds: claim.retryInSeconds, channels: cfg.channels };
    }

    const fetchFn = d.fetchFn ?? fetch;
    const clickedAt = (d.now ?? (() => new Date()))();
    d.schedule(async () => {
      try {
        const msg = buildMessage(d.data, clickedAt);
        const [telegram, email] = await Promise.all([
          cfg.telegram ? sendTelegram(cfg.telegram, msg.telegramParts, fetchFn).catch(() => false) : Promise.resolve(null),
          cfg.email ? sendEmail(cfg.email, msg, fetchFn).catch(() => false) : Promise.resolve(null),
        ]);
        // Outcome only (no text, no addresses, no keys): visible in the Vercel logs.
        console.log("notify", JSON.stringify({ telegram, email, rows: msg.rows }));
      } catch {
        /* a delivery problem never reaches the caller */
      }
    });
    return { status: "sending", channels: cfg.channels };
  } catch {
    return { status: "off" };
  }
}

import {
  APP_PUBLIC_URL,
  NOTIFY_COOLDOWN_SECONDS,
  NOTIFY_TIMEOUT_MS,
  NOTIFY_TOP_N,
  TELEGRAM_PART_LIMIT,
} from "./config";
import type { Notification, ScoredLaunch, ScoutResponse } from "./types";
import { NO_ANGLE } from "./verify";
import { CATEGORIES, categoryLabel } from "./categories";

// Sends a copy of the list that the server just built to Kavya's OWN Telegram and email.
// Triggered only by a real Generate. The client supplies no text and no recipients.
// Recipients and keys come only from server env vars and never leave this module.

export type Channel = "telegram" | "email";

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

/**
 * The page can switch channels OFF for the next Generate. This reads that choice and only ever narrows what the server
 * allows: valid values are "telegram" and "email"; anything malformed means "no choice made" (undefined, so every configured
 * channel stays on); an empty list means the visitor switched both off. It can never add a channel, recipient or text.
 */
export function parseChannels(input: unknown): Channel[] | undefined {
  if (!Array.isArray(input) || input.length > 4) return undefined;
  const out: Channel[] = [];
  for (const v of input) {
    if (v !== "telegram" && v !== "email") return undefined;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- is this a real Generate?
/**
 * True only for the Generate button: not Refresh now, and the request must carry the headers a browser page of this
 * app sends (Sec-Fetch-Site: same-origin, or an Origin that matches the Host). Other websites and honest scripts do
 * not send them. This is a convenience boundary, not authentication: a client that deliberately sets the header can
 * pass, which is why the limit of one copy per 5 minutes, to Kavya only, is the real protection. A client-supplied
 * "please send" field does not exist.
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
  possible: "Partial fit",
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
export const ist = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") + " IST";

interface Entry {
  title: string;
  about: string;
  founders: string;
  why: string;
  angle: string;
  link: string;
}

const launchedText = (days: number) => (days <= 0 ? "launched today" : days === 1 ? "launched 1 day ago" : `launched ${days} days ago`);

function entryOf(r: ScoredLaunch, rank: number): Entry {
  const angleMissing = r.ai.fit === "unrated" || r.ai.angle === NO_ANGLE || !r.ai.angle;
  const comments = r.makerComments === null ? "maker comments not counted yet" : `${r.makerComments} maker comments`;
  return {
    title: `#${rank} ${clean(r.name, 80)} (${FIT_LABEL[r.ai.fit]})`,
    about: clean(r.ai.oneLiner || r.tagline, 160),
    founders: founderText(r.founders),
    why: `score ${r.score.toFixed(1)} out of 100${r.provisional ? " (provisional)" : ""}, from ${r.votesCount} upvotes and ${comments}; ${launchedText(r.daysSinceLaunch)}`,
    angle: angleMissing ? "angle unavailable, open the launch page" : clean(r.ai.angle, 300),
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
  const core = CATEGORIES.map((c) => c.label).join(", ").replace(/, ([^,]*)$/, " and $1");
  const extras = (data.extras ?? []).map((id) => categoryLabel(id));
  const where = extras.length ? `${core}, plus the optional categories you switched on (${extras.join(", ")})` : core;
  const header = "Partnership Scout: your outreach shortlist";
  const intro =
    `You clicked Generate on ${ist(clickedAt)}. Below are the top ${entries.length} of ${data.ranked.length} Product Hunt launches from the last 7 days ` +
    `(${ist(new Date(data.window.from))} to ${ist(new Date(data.window.to))}) in ${where}, ranked by upvotes and maker comments.`;
  const source = `Data: ${data.source}${data.source === "CACHED" ? " (saved copy)" : ""}, fetched ${ist(new Date(data.fetchedAt))}.`;
  const howTo =
    "How to read this: the score (0 to 100) uses only upvotes and maker comments. The fit tags and angles are AI suggestions from Gemini Flash and never change the order. " +
    "Reach out to the founders yourself while they are in their first week.";
  const footer = [howTo, `Full list, filters and draft messages: ${appUrl}`, "This copy was sent only to you. Nothing was sent to any founder."];

  const entryText = (e: Entry) =>
    [e.title, `What it is: ${e.about}`, `Founders: ${e.founders}`, `Why it ranks here: ${e.why}`, `Suggested angle (AI): ${e.angle}`, e.link].filter(Boolean).join("\n");
  const body = entries.map(entryText);
  const lead = [header, intro, source].join("\n\n");
  const text = [lead, "", ...body.flatMap((b) => [b, ""]), ...footer.flatMap((f) => [f, ""])].join("\n").trimEnd() + "\n";

  // Telegram: plain text (no parse_mode), split at entry boundaries under the limit.
  const telegramParts: string[] = [];
  let current = lead;
  const flush = () => {
    if (current.trim()) telegramParts.push(current.trimEnd());
    current = "";
  };
  for (const b of [...body, footer.join("\n\n")]) {
    const piece = b.length > TELEGRAM_PART_LIMIT ? b.slice(0, TELEGRAM_PART_LIMIT - 1) + "…" : b;
    if (current && (current + "\n\n" + piece).length > TELEGRAM_PART_LIMIT) flush();
    current = current ? current + "\n\n" + piece : piece;
  }
  flush();
  const parts = telegramParts.length > 1 ? telegramParts.map((p, i) => `${p}\n\n(part ${i + 1} of ${telegramParts.length})`) : telegramParts;

  const li = (e: Entry) =>
    `<li style="margin-bottom:14px"><strong>${escapeHtml(e.title)}</strong><br>What it is: ${escapeHtml(e.about)}<br>Founders: ${escapeHtml(e.founders)}<br>` +
    `Why it ranks here: ${escapeHtml(e.why)}<br>Suggested angle (AI): ${escapeHtml(e.angle)}` +
    (e.link ? `<br><a href="${escapeHtml(e.link)}">${escapeHtml(e.link)}</a>` : "") +
    "</li>";
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45">` +
    `<h2 style="font-size:17px">${escapeHtml(header)}</h2><p>${escapeHtml(intro)}</p><p>${escapeHtml(source)}</p><ol>${entries.map(li).join("")}</ol>` +
    `<p>${escapeHtml(footer[0])}</p><p>Full list, filters and draft messages: <a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p><p>${escapeHtml(footer[2])}</p></div>`;

  return { telegramParts: parts, subject: `Partnership Scout: your top ${entries.length} launches from the last 7 days (${ist(clickedAt)})`, text, html, rows: entries.length };
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
export type ClaimResult = { ok: true } | { ok: false; reason: "cooldown" | "unavailable"; retryInSeconds?: number };

export interface Limiter {
  /** Atomically takes one send slot (1 per 5 minutes). A taken slot is never given back. */
  claim(): Promise<ClaimResult>;
}

/** In-memory limiter with the same rules as the Neon one. Used by tests; the claim section is synchronous (atomic). */
export function memoryLimiter(clock: () => Date): Limiter {
  let last: number | null = null;
  return {
    async claim() {
      const now = clock().getTime();
      if (last !== null && now - last < NOTIFY_COOLDOWN_SECONDS * 1000) {
        return { ok: false, reason: "cooldown", retryInSeconds: Math.ceil((last + NOTIFY_COOLDOWN_SECONDS * 1000 - now) / 1000) };
      }
      last = now;
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
  wanted?: Channel[]; // the visitor's channel choice from the page (see parseChannels); undefined = every configured channel
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

    // Only configured channels can be used; the visitor's choice can switch some off but never add one.
    const active = d.wanted === undefined ? cfg.channels : cfg.channels.filter((c) => d.wanted?.includes(c));
    if (active.length === 0) return { status: "skipped", channels: [] }; // switched off on the page: no send, and no send slot is used

    const claim = await d.limiter().claim();
    if (!claim.ok) {
      if (claim.reason === "unavailable") return { status: "off" }; // cannot enforce the limits: send nothing
      return { status: claim.reason, retryInSeconds: claim.retryInSeconds, channels: active };
    }

    const fetchFn = d.fetchFn ?? fetch;
    const clickedAt = (d.now ?? (() => new Date()))();
    d.schedule(async () => {
      try {
        const msg = buildMessage(d.data, clickedAt);
        const [telegram, email] = await Promise.all([
          cfg.telegram && active.includes("telegram") ? sendTelegram(cfg.telegram, msg.telegramParts, fetchFn).catch(() => false) : Promise.resolve(null),
          cfg.email && active.includes("email") ? sendEmail(cfg.email, msg, fetchFn).catch(() => false) : Promise.resolve(null),
        ]);
        // Outcome only (no text, no addresses, no keys): visible in the Vercel logs.
        console.log("notify", JSON.stringify({ telegram, email, rows: msg.rows }));
      } catch {
        /* a delivery problem never reaches the caller */
      }
    });
    return { status: "sending", channels: active };
  } catch {
    return { status: "off" };
  }
}

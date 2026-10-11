import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NOTIFY_COOLDOWN_SECONDS, NOTIFY_DAILY_CAP, TELEGRAM_PART_LIMIT } from "../lib/config";
import {
  buildMessage,
  clean,
  escapeHtml,
  isRealGenerate,
  maybeNotify,
  memoryLimiter,
  notifyConfig,
  safeLink,
  sendEmail,
  sendTelegram,
  type Limiter,
} from "../lib/notify";
import { handleScout } from "../lib/scout-handler";
import type { ScoredLaunch, ScoutResponse } from "../lib/types";

// ---------------------------------------------------------------- fixtures (no real network, no real sends)
const ENV = {
  NOTIFICATIONS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "111:TESTTOKEN",
  TELEGRAM_CHAT_ID: "42",
  RESEND_API_KEY: "re_testkey",
  NOTIFY_EMAIL: "kavya@example.com",
};

const row = (i: number, over: Partial<ScoredLaunch> = {}): ScoredLaunch => ({
  id: String(i), name: `Product ${i}`, tagline: "t", description: "d", url: `https://www.producthunt.com/products/p${i}`,
  votesCount: 100 - i, commentsCount: 5, createdAt: "2026-10-08T07:01:00Z", makerComments: 10 + i, makerCommentsStale: false,
  votesHidden: false, daysSinceLaunch: 3, urgency: "week", categories: ["hr-tech"],
  founders: { names: [`Founder ${i}`], hiddenCount: 0, hunter: null }, score: 90 - i, provisional: false,
  parts: { votes: 100 - i, maxVotes: 100, votesShare: 1, makerComments: 10 + i, maxMakerComments: 20, makerShare: 0.5, votesPoints: 50, makerPoints: 25 },
  ai: { available: true, oneLiner: "x", fit: "strong", fitReason: "r", angle: `Your tool ${i}; our standups help`, evidenceQuote: "q", quoteStatus: "verified" },
  firstSeenAt: null, ...over,
});

const data = (over: Partial<ScoutResponse> = {}, n = 12): ScoutResponse => ({
  source: "LIVE", fetchedAt: "2026-10-11T12:00:00.000Z", generatedAt: "2026-10-11T12:01:00.000Z",
  window: { from: "2026-10-04T12:00:00Z", to: "2026-10-11T12:00:00Z" },
  ranked: Array.from({ length: n }, (_, i) => row(i + 1)), tooEarly: [], moreLaunches: [], warnings: [],
  counted: { n, of: n, stale: 0 }, ai: { available: true, sentToGemini: 0, reusedSaved: n, model: "m" },
  refresh: { allowedNow: true, nextAvailableAt: null, applied: false }, newTagging: true, tookMs: 5, ...over,
});

const browserHeaders = () => new Headers({ "sec-fetch-site": "same-origin", host: "ph-scout.vercel.app" });

interface Call { url: string; body: Record<string, unknown>; headers: Record<string, string> }
function fakeFetch(handlers: { telegram?: () => Response | Promise<Response>; email?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")), headers: (init?.headers ?? {}) as Record<string, string> });
    if (u.includes("api.telegram.org")) return (handlers.telegram ?? (() => Response.json({ ok: true })))();
    if (u.includes("api.resend.com")) return (handlers.email ?? (() => Response.json({ id: "email_1" })))();
    throw new Error("unexpected url " + u);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const clock = (start = "2026-10-11T12:00:00Z") => {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (s: number) => (t += s * 1000) };
};

function harness(opts: { env?: Record<string, string | undefined>; fetch?: ReturnType<typeof fakeFetch>; limiter?: Limiter & { logs?: unknown[] }; c?: ReturnType<typeof clock> } = {}) {
  const c = opts.c ?? clock();
  const limiter = opts.limiter ?? memoryLimiter(c.now);
  const f = opts.fetch ?? fakeFetch();
  const pending: Promise<void>[] = [];
  const schedule = (task: () => Promise<void>) => void pending.push(task());
  return { c, limiter, f, pending, schedule, settle: () => Promise.all(pending), env: opts.env ?? ENV };
}

// ---------------------------------------------------------------- 1. only a real Generate sends
describe("isRealGenerate", () => {
  it("is false for Refresh now", () => expect(isRealGenerate(browserHeaders(), true)).toBe(false));
  it("is true for a same-origin browser Generate", () => expect(isRealGenerate(browserHeaders(), false)).toBe(true));
  it("is false for cross-site or same-site requests", () => {
    expect(isRealGenerate(new Headers({ "sec-fetch-site": "cross-site" }), false)).toBe(false);
    expect(isRealGenerate(new Headers({ "sec-fetch-site": "same-site" }), false)).toBe(false);
  });
  it("is false for scripts and curl (no browser headers)", () => expect(isRealGenerate(new Headers(), false)).toBe(false));
  it("accepts a matching Origin only when Sec-Fetch-Site is absent", () => {
    expect(isRealGenerate(new Headers({ origin: "https://ph-scout.vercel.app", host: "ph-scout.vercel.app" }), false)).toBe(true);
    expect(isRealGenerate(new Headers({ origin: "https://evil.example", host: "ph-scout.vercel.app" }), false)).toBe(false);
    expect(isRealGenerate(new Headers({ origin: "not a url", host: "ph-scout.vercel.app" }), false)).toBe(false);
  });
});

describe("maybeNotify decides who gets a send", () => {
  it("sends on a real Generate with LIVE data: Telegram and email, with provider confirmation", async () => {
    const h = harness();
    const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now });
    expect(n).toEqual({ status: "sending", channels: ["telegram", "email"] });
    await h.settle();
    expect(h.f.calls.map((c) => new URL(c.url).host)).toEqual(["api.telegram.org", "api.resend.com"]);
    expect((h.limiter as ReturnType<typeof memoryLimiter>).logs).toEqual([{ status: "sent", telegram: "sent", email: "sent", rows: 10 }]);
  });
  it("sends for CACHED data too", async () => {
    const h = harness();
    const n = await maybeNotify({ generate: true, data: data({ source: "CACHED" }), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("sending");
    await h.settle();
    expect(h.f.calls.length).toBe(2);
  });
  it("never sends for SAMPLE data and does not use up a claim", async () => {
    const h = harness();
    const n = await maybeNotify({ generate: true, data: data({ source: "SAMPLE" }), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("skipped_sample");
    await h.settle();
    expect(h.f.calls.length).toBe(0);
    expect((await h.limiter.claim()).ok).toBe(true); // nothing was claimed
  });
  it("never sends on Refresh now, and never even touches the limiter or the network", async () => {
    const limiter = { claim: vi.fn(), release: vi.fn(), log: vi.fn() };
    const h = harness({ limiter });
    const n = await maybeNotify({ generate: isRealGenerate(browserHeaders(), true), data: data(), env: h.env, limiter: () => limiter, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("skipped");
    expect(limiter.claim).not.toHaveBeenCalled();
    expect(h.f.calls.length).toBe(0);
  });
  it("does not send when there is nothing to send", async () => {
    const h = harness();
    const n = await maybeNotify({ generate: true, data: data({}, 0), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("skipped");
    expect(h.f.calls.length).toBe(0);
  });
  it("still sends when Gemini is unavailable, with 'angle unavailable'", async () => {
    const h = harness();
    const noAi = data({ ai: { available: false, sentToGemini: 5, reusedSaved: 0, model: "m" } });
    noAi.ranked = noAi.ranked.map((r) => ({ ...r, ai: { ...r.ai, available: false, fit: "unrated", angle: "No angle available — review the launch page", evidenceQuote: null, quoteStatus: "none" } }));
    await maybeNotify({ generate: true, data: noAi, env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    await h.settle();
    const text = String(h.f.calls[0].body.text);
    expect(text).toContain("angle unavailable");
    expect(text).not.toContain("AI suggestion");
    expect(text).toContain("Not rated");
  });
});

describe("kill switches", () => {
  it("sends nothing unless NOTIFICATIONS_ENABLED is exactly 'true'", async () => {
    for (const v of [undefined, "", "false", "1", "TRUE", "yes"]) {
      const h = harness({ env: { ...ENV, NOTIFICATIONS_ENABLED: v } });
      const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
      expect(n.status).toBe("off");
      expect(h.f.calls.length).toBe(0);
    }
  });
  it("without any channel variables the app behaves as before (off, no database use)", async () => {
    const limiter = { claim: vi.fn(), release: vi.fn(), log: vi.fn() };
    const h = harness({ env: { NOTIFICATIONS_ENABLED: "true" }, limiter });
    const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => limiter, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("off");
    expect(limiter.claim).not.toHaveBeenCalled();
  });
  it("each channel is independent: Telegram only, email only", async () => {
    const tgOnly = harness({ env: { ...ENV, RESEND_API_KEY: undefined } });
    const n1 = await maybeNotify({ generate: true, data: data(), env: tgOnly.env, limiter: () => tgOnly.limiter, schedule: tgOnly.schedule, fetchFn: tgOnly.f.fn });
    await tgOnly.settle();
    expect(n1.channels).toEqual(["telegram"]);
    expect(tgOnly.f.calls.map((c) => new URL(c.url).host)).toEqual(["api.telegram.org"]);
    const mailOnly = harness({ env: { ...ENV, TELEGRAM_CHAT_ID: undefined } });
    const n2 = await maybeNotify({ generate: true, data: data(), env: mailOnly.env, limiter: () => mailOnly.limiter, schedule: mailOnly.schedule, fetchFn: mailOnly.f.fn });
    await mailOnly.settle();
    expect(n2.channels).toEqual(["email"]);
    expect(mailOnly.f.calls.map((c) => new URL(c.url).host)).toEqual(["api.resend.com"]);
  });
  it("notifyConfig needs both parts of a channel", () => {
    expect(notifyConfig({ NOTIFICATIONS_ENABLED: "true", TELEGRAM_BOT_TOKEN: "x" }).enabled).toBe(false);
    expect(notifyConfig({ NOTIFICATIONS_ENABLED: "true", NOTIFY_EMAIL: "a@b.c" }).enabled).toBe(false);
    expect(notifyConfig(ENV).channels).toEqual(["telegram", "email"]);
  });
});

// ---------------------------------------------------------------- 2. atomic limits
describe("limits", () => {
  it("under concurrent Generates only ONE wins", async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 8 }, () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now })));
    await h.settle();
    expect(results.filter((r) => r.status === "sending").length).toBe(1);
    expect(results.filter((r) => r.status === "cooldown").length).toBe(7);
    expect(h.f.calls.length).toBe(2); // one Telegram + one email, not sixteen
  });
  it("a second Generate inside 5 minutes is blocked with a countdown and sends nothing", async () => {
    const h = harness();
    const run = () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now });
    expect((await run()).status).toBe("sending");
    h.c.advance(60);
    const second = await run();
    expect(second.status).toBe("cooldown");
    expect(second.retryInSeconds).toBe(NOTIFY_COOLDOWN_SECONDS - 60);
    await h.settle();
    expect(h.f.calls.length).toBe(2);
    h.c.advance(NOTIFY_COOLDOWN_SECONDS - 60);
    expect((await run()).status).toBe("sending"); // exactly 5 minutes later
  });
  it("stops at the daily cap and resets on the next UTC day", async () => {
    const h = harness({ c: clock("2026-10-11T00:10:00Z") });
    const run = () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now });
    for (let i = 0; i < NOTIFY_DAILY_CAP; i++) {
      expect((await run()).status).toBe("sending");
      h.c.advance(NOTIFY_COOLDOWN_SECONDS);
    }
    const capped = await run();
    expect(capped.status).toBe("daily_cap");
    expect(capped.retryInSeconds).toBeGreaterThan(0);
    await h.settle();
    expect(h.f.calls.length).toBe(NOTIFY_DAILY_CAP * 2);
    h.c.advance(24 * 3600); // next UTC day
    expect((await run()).status).toBe("sending");
  });
  it("a blocked Generate costs nothing: it is logged as blocked and sends nothing", async () => {
    const h = harness();
    const run = () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now });
    await run();
    await run();
    await h.settle();
    const logs = (h.limiter as ReturnType<typeof memoryLimiter>).logs;
    expect(logs.map((l) => l.status).sort()).toEqual(["blocked", "sent"]);
  });
  it("fails closed when the limits cannot be checked (database unavailable): sends nothing", async () => {
    const unavailable: Limiter = { claim: async () => ({ ok: false, reason: "unavailable" }), release: async () => {}, log: async () => {} };
    const h = harness({ limiter: unavailable });
    const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => unavailable, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("off");
    expect(h.f.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------- 3. claim release / keep
describe("claim handling after delivery", () => {
  const run = async (tg: () => Response | Promise<Response>, em: () => Response | Promise<Response>) => {
    const h = harness({ fetch: fakeFetch({ telegram: tg, email: em }) });
    const go = () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now });
    await go();
    await h.settle();
    const again = await go(); // immediately, to see whether the claim was kept or released
    await h.settle();
    return { status: (h.limiter as ReturnType<typeof memoryLimiter>).logs[0].status, again: again.status };
  };
  it("releases the claim when BOTH channels clearly fail", async () => {
    const r = await run(() => Response.json({ ok: false }, { status: 401 }), () => Response.json({ message: "bad key" }, { status: 403 }));
    expect(r).toEqual({ status: "failed", again: "sending" });
  });
  it("keeps the claim when one channel succeeds (partial)", async () => {
    const r = await run(() => Response.json({ ok: true }), () => Response.json({}, { status: 422 }));
    expect(r).toEqual({ status: "partial", again: "cooldown" });
  });
  it("keeps the claim and never retries when the outcome is ambiguous (timeout / 5xx)", async () => {
    const timeout = () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const r = await run(timeout, () => Response.json({}, { status: 503 }));
    expect(r).toEqual({ status: "unknown", again: "cooldown" });
  });
  it("never retries an ambiguous send automatically: exactly one call per channel", async () => {
    const f = fakeFetch({ telegram: () => Response.json({}, { status: 502 }), email: () => Response.json({}, { status: 500 }) });
    const h = harness({ fetch: f });
    await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: f.fn });
    await h.settle();
    expect(f.calls.length).toBe(2);
  });
  it("one failing channel never blocks the other", async () => {
    const f = fakeFetch({ telegram: () => Promise.reject(new Error("boom")) });
    const h = harness({ fetch: f });
    await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: f.fn });
    await h.settle();
    expect(f.calls.some((c) => c.url.includes("api.resend.com"))).toBe(true);
    expect((h.limiter as ReturnType<typeof memoryLimiter>).logs[0]).toEqual({ status: "partial", telegram: "unknown", email: "sent", rows: 10 });
  });
});

describe("a channel only counts as sent when the provider confirms", () => {
  it("Telegram needs ok:true", async () => {
    expect(await sendTelegram({ token: "t", chatId: "1" }, ["hi"], fakeFetch({ telegram: () => Response.json({ ok: true }) }).fn)).toBe("sent");
    expect(await sendTelegram({ token: "t", chatId: "1" }, ["hi"], fakeFetch({ telegram: () => Response.json({ ok: false }) }).fn)).toBe("failed");
  });
  it("Resend needs an id", async () => {
    const cfg = { apiKey: "k", to: "a@b.c" };
    const msg = buildMessage(data(), new Date());
    expect(await sendEmail(cfg, msg, fakeFetch({ email: () => Response.json({ id: "abc" }) }).fn)).toBe("sent");
    expect(await sendEmail(cfg, msg, fakeFetch({ email: () => Response.json({}) }).fn)).toBe("unknown"); // 200 without an id
    expect(await sendEmail(cfg, msg, fakeFetch({ email: () => Response.json({}, { status: 403 }) }).fn)).toBe("failed");
  });
  it("uses an 8 second timeout and no parse_mode", async () => {
    const f = fakeFetch();
    const spy = vi.spyOn(AbortSignal, "timeout");
    await sendTelegram({ token: "t", chatId: "1" }, ["hi"], f.fn);
    expect(spy).toHaveBeenCalledWith(8000);
    expect(f.calls[0].body).not.toHaveProperty("parse_mode");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------- 4. the client cannot control what or to whom
describe("the client cannot inject text or recipients", () => {
  it("ignores extra fields in a hand-made POST; recipients and text come only from the server", async () => {
    const h = harness();
    const req = new Request("https://ph-scout.vercel.app/api/scout", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "ph-scout.vercel.app" },
      body: JSON.stringify({ refresh: false, notify: true, send: true, to: "attacker@evil.example", email: "attacker@evil.example", chat_id: "999", chatId: "999", text: "BUY CRYPTO NOW", message: "BUY CRYPTO NOW", subject: "evil" }),
    });
    const out = await handleScout(req, { run: async () => data(), limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: h.f.fn, now: h.c.now });
    await h.settle();
    expect(out.notification.status).toBe("sending");
    const tg = h.f.calls.find((c) => c.url.includes("telegram"))!;
    const mail = h.f.calls.find((c) => c.url.includes("resend"))!;
    expect(tg.body.chat_id).toBe("42");
    expect(mail.body.to).toEqual(["kavya@example.com"]);
    const all = JSON.stringify(h.f.calls.map((c) => c.body));
    expect(all).not.toContain("BUY CRYPTO");
    expect(all).not.toContain("attacker");
    expect(all).not.toContain("999");
    expect(String(mail.body.subject)).not.toContain("evil");
  });
  it("a hand-made POST WITHOUT browser headers (curl) never sends, even with notify fields", async () => {
    const h = harness();
    const req = new Request("https://ph-scout.vercel.app/api/scout", { method: "POST", body: JSON.stringify({ notify: true, send: true }) });
    const out = await handleScout(req, { run: async () => data(), limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: h.f.fn });
    expect(out.notification.status).toBe("skipped");
    expect(h.f.calls.length).toBe(0);
  });
  it("Refresh now from a browser never sends", async () => {
    const h = harness();
    const req = new Request("https://ph-scout.vercel.app/api/scout", { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: JSON.stringify({ refresh: true }) });
    const out = await handleScout(req, { run: async () => data(), limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: h.f.fn });
    expect(out.notification.status).toBe("skipped");
    expect(h.f.calls.length).toBe(0);
  });
  it("an empty body is a plain Generate", async () => {
    const h = harness();
    const req = new Request("https://ph-scout.vercel.app/api/scout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    const out = await handleScout(req, { run: async () => data(), limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: h.f.fn, now: h.c.now });
    expect(out.notification.status).toBe("sending");
  });
  it("/api/refresh and the page never import or call the notification code", () => {
    expect(readFileSync("app/api/refresh/route.ts", "utf8")).not.toMatch(/notify|scout-handler|telegram|resend/i);
    expect(readFileSync("lib/pipeline.ts", "utf8")).not.toMatch(/notify|telegram|resend/i);
    expect(readFileSync("app/page.tsx", "utf8")).not.toMatch(/telegram\.org|resend\.com|TELEGRAM_BOT_TOKEN|RESEND_API_KEY/);
  });
  it("the scheduled GitHub Action only calls /api/refresh", () => {
    const yml = readFileSync(".github/workflows/refresh.yml", "utf8");
    expect(yml).toContain("/api/refresh");
    expect(yml).not.toContain("/api/scout");
  });
});

// ---------------------------------------------------------------- 5. Generate still works normally
describe("Generate keeps working", () => {
  it("returns the normal list when sending is off", async () => {
    const h = harness({ env: {} });
    const base = data();
    const req = new Request("https://x/api/scout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    const out = await handleScout(req, { run: async () => base, limiter: () => h.limiter, schedule: h.schedule, env: {} });
    expect(out.ranked).toEqual(base.ranked);
    expect(out.notification.status).toBe("off");
  });
  it("returns the normal list even if the limiter blows up or delivery fails", async () => {
    const boom: Limiter = { claim: async () => { throw new Error("db exploded"); }, release: async () => {}, log: async () => {} };
    const base = data();
    const req = new Request("https://x/api/scout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    const out = await handleScout(req, { run: async () => base, limiter: () => boom, schedule: (t) => void t(), env: ENV });
    expect(out.ranked).toEqual(base.ranked);
    expect(out.notification.status).toBe("off");
    const f = fakeFetch({ telegram: () => Promise.reject(new Error("net")), email: () => Promise.reject(new Error("net")) });
    const h = harness({ fetch: f });
    const out2 = await handleScout(req, { run: async () => base, limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: f.fn });
    await h.settle();
    expect(out2.ranked).toEqual(base.ranked);
  });
  it("sending does not change the order or any score in the response", async () => {
    const h = harness();
    const base = data();
    const before = JSON.stringify(base.ranked);
    const req = new Request("https://x/api/scout", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    const out = await handleScout(req, { run: async () => base, limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: h.f.fn });
    await h.settle();
    expect(JSON.stringify(out.ranked)).toBe(before);
  });
});

// ---------------------------------------------------------------- 6. message content
describe("message content", () => {
  const msg = () => buildMessage(data(), new Date("2026-10-11T12:05:00Z"));
  it("has the required header, source line, top 10 only, and footer", () => {
    const m = msg();
    expect(m.text).toContain("PH Scout: your list (Generate clicked 2026-10-11 12:05 UTC)");
    expect(m.text).toContain("Source: LIVE, fetched 2026-10-11 12:00 UTC");
    expect(m.rows).toBe(10);
    expect(m.text).toContain("#10 Product 10");
    expect(m.text).not.toContain("#11 ");
    expect(m.text).toContain("Open the app: https://ph-scout.vercel.app");
    expect(m.text).toContain("For you only. Nothing was sent to anyone else.");
  });
  it("has rank, name, founders, score, upvotes, maker comments, days, fit, AI-marked angle and link", () => {
    const first = msg().text.split("\n\n").find((b) => b.startsWith("#1 "))!;
    expect(first).toContain("Founders: Founder 1");
    expect(first).toContain("score 89.0");
    expect(first).toContain("99 upvotes");
    expect(first).toContain("11 maker comments");
    expect(first).toContain("day 3");
    expect(first).toContain("Strong fit");
    expect(first).toContain("AI suggestion: Your tool 1; our standups help");
    expect(first).toContain("https://www.producthunt.com/products/p1");
  });
  it("marks provisional scores and uncounted maker comments", () => {
    const d = data();
    d.ranked[0] = row(1, { provisional: true, makerComments: null });
    const text = buildMessage(d, new Date()).text;
    expect(text).toContain("score 89.0 (provisional)");
    expect(text).toContain("maker comments not counted");
  });
  it("says CACHED honestly", () => {
    expect(buildMessage(data({ source: "CACHED" }), new Date()).text).toContain("Source: CACHED (saved copy)");
  });
  it("labels a hunter as a hunter and never invents founder contact details", () => {
    const d = data();
    d.ranked[0] = row(1, { founders: { names: [], hiddenCount: 0, hunter: "Hugo" } });
    const text = buildMessage(d, new Date()).text;
    expect(text).toContain("Hugo (hunter, may not be the founder)");
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });
  it("escapes HTML in the email version", () => {
    const d = data();
    d.ranked[0] = row(1, { name: `<script>alert("x")</script> & 'Co'`, founders: { names: ["<b>A</b>"], hiddenCount: 0, hunter: null }, ai: { ...row(1).ai, angle: `a < b & "c"` } });
    const { html } = buildMessage(d, new Date());
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>A</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;");
    expect(html).toContain("a &lt; b &amp; &quot;c&quot;");
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
  it("truncates long fields and strips control characters", () => {
    const d = data();
    d.ranked[0] = row(1, { name: "N".repeat(500), ai: { ...row(1).ai, angle: "word ".repeat(500) + "\u0000\u0007" } });
    const text = buildMessage(d, new Date()).text;
    const e = text.split("\n\n").find((b) => b.startsWith("#1 "))!;
    expect(e.split("\n")[0].length).toBeLessThanOrEqual(90);
    expect(e).not.toMatch(/[\u0000-\u0008]/);
    expect(clean("a\n\n  b\tc", 50)).toBe("a b c");
    expect(clean("x".repeat(20), 10).length).toBe(10);
  });
  it("splits Telegram text under the limit without losing any entry", () => {
    const d = data();
    d.ranked = d.ranked.map((r, i) => ({ ...r, ai: { ...r.ai, angle: `angle ${i} ` + "long ".repeat(55) }, founders: { names: ["F".repeat(100)], hiddenCount: 0, hunter: null } }));
    const m = buildMessage(d, new Date());
    expect(m.telegramParts.length).toBeGreaterThan(1);
    for (const p of m.telegramParts) expect(p.length).toBeLessThan(4000);
    for (const p of m.telegramParts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_PART_LIMIT + 40);
    const joined = m.telegramParts.join("\n");
    for (let i = 1; i <= 10; i++) expect(joined).toContain(`#${i} Product ${i}`);
    expect(m.telegramParts[0]).toContain(`(part 1 of ${m.telegramParts.length})`);
  });
  it("Telegram text is plain (no HTML or markdown parse)", async () => {
    const f = fakeFetch();
    const h = harness({ fetch: f });
    await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: f.fn });
    await h.settle();
    expect(f.calls[0].body).toEqual({ chat_id: "42", text: expect.any(String), disable_web_page_preview: true });
  });
  it("only allows Product Hunt links", () => {
    expect(safeLink("https://www.producthunt.com/products/x")).toBe("https://www.producthunt.com/products/x");
    for (const bad of ["http://www.producthunt.com/x", "https://producthunt.com/x", "https://www.producthunt.com.evil.example/x", "javascript:alert(1)", "https://evil.example/https://www.producthunt.com/", "https://www.producthunt.com/x y", "https://www.producthunt.com/x\"onmouseover=\""]) {
      expect(safeLink(bad)).toBe("");
    }
    const d = data();
    d.ranked[0] = row(1, { url: "https://evil.example/phish" });
    const m = buildMessage(d, new Date());
    expect(m.text).not.toContain("evil.example");
    expect(m.html).not.toContain("evil.example");
  });
  it("never puts secrets, addresses or stack traces in the message or the notification result", async () => {
    const h = harness();
    const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    await h.settle();
    const everything = JSON.stringify([n, h.f.calls.map((c) => c.body), (h.limiter as ReturnType<typeof memoryLimiter>).logs]);
    for (const secret of ["TESTTOKEN", "re_testkey", "kavya@example.com", "111:"]) {
      // the recipient and the token legitimately appear only where the provider needs them (url / `to`), never in the status or the log
      expect(JSON.stringify([n, (h.limiter as ReturnType<typeof memoryLimiter>).logs])).not.toContain(secret);
    }
    expect(everything).not.toMatch(/\bat\s+\S+\s+\(.*:\d+:\d+\)/); // no stack frames
  });
});

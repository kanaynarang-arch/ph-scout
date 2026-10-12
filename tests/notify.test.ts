import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NOTIFY_COOLDOWN_SECONDS, TELEGRAM_PART_LIMIT } from "../lib/config";
import {
  buildMessage,
  ist,
  clean,
  escapeHtml,
  isRealGenerate,
  maybeNotify,
  memoryLimiter,
  notifyConfig,
  parseChannels,
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

function harness(opts: { env?: Record<string, string | undefined>; fetch?: ReturnType<typeof fakeFetch>; limiter?: Limiter; c?: ReturnType<typeof clock> } = {}) {
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
    expect(text).not.toContain("Your tool");
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
  it("a blocked Generate costs nothing and sends nothing", async () => {
    const h = harness();
    const run = () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now });
    await run();
    const second = await run();
    await h.settle();
    expect(second.status).toBe("cooldown");
    expect(h.f.calls.length).toBe(2); // only the first Generate sent (one Telegram + one email)
  });
  it("fails closed when the limits cannot be checked (database unavailable): sends nothing", async () => {
    const unavailable: Limiter = { claim: async () => ({ ok: false, reason: "unavailable" }) };
    const h = harness({ limiter: unavailable });
    const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => unavailable, schedule: h.schedule, fetchFn: h.f.fn });
    expect(n.status).toBe("off");
    expect(h.f.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------- 3. a taken slot is never given back
describe("after a send attempt", () => {
  const run = async (tg: () => Response | Promise<Response>, em: () => Response | Promise<Response>) => {
    const f = fakeFetch({ telegram: tg, email: em });
    const h = harness({ fetch: f });
    const go = () => maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: f.fn, now: h.c.now });
    await go();
    await h.settle();
    const again = await go(); // immediately: the slot must still be taken
    await h.settle();
    return { again: again.status, calls: f.calls.length };
  };
  it("keeps the slot when both channels fail, and never retries on its own", async () => {
    expect(await run(() => Response.json({ ok: false }, { status: 401 }), () => Response.json({ message: "bad key" }, { status: 403 }))).toEqual({ again: "cooldown", calls: 2 });
  });
  it("keeps the slot after a partial success", async () => {
    expect(await run(() => Response.json({ ok: true }), () => Response.json({}, { status: 422 }))).toEqual({ again: "cooldown", calls: 2 });
  });
  it("keeps the slot after timeouts or server errors, with exactly one call per channel", async () => {
    const timeout = () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    expect(await run(timeout, () => Response.json({}, { status: 503 }))).toEqual({ again: "cooldown", calls: 2 });
  });
  it("one failing channel never blocks the other", async () => {
    const f = fakeFetch({ telegram: () => Promise.reject(new Error("boom")) });
    const h = harness({ fetch: f });
    await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: f.fn });
    await h.settle();
    expect(f.calls.some((c) => c.url.includes("api.resend.com"))).toBe(true);
  });
  it("logs only the outcome (no text, tokens or addresses)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    await h.settle();
    const lines = spy.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("notify"));
    spy.mockRestore();
    expect(lines).toEqual(['notify {"telegram":true,"email":true,"rows":10}']);
  });
});

describe("a channel only counts as sent when the provider confirms", () => {
  it("Telegram needs ok:true", async () => {
    expect(await sendTelegram({ token: "t", chatId: "1" }, ["hi"], fakeFetch({ telegram: () => Response.json({ ok: true }) }).fn)).toBe(true);
    expect(await sendTelegram({ token: "t", chatId: "1" }, ["hi"], fakeFetch({ telegram: () => Response.json({ ok: false }) }).fn)).toBe(false);
  });
  it("Resend needs an id", async () => {
    const cfg = { apiKey: "k", to: "a@b.c" };
    const msg = buildMessage(data(), new Date());
    expect(await sendEmail(cfg, msg, fakeFetch({ email: () => Response.json({ id: "abc" }) }).fn)).toBe(true);
    expect(await sendEmail(cfg, msg, fakeFetch({ email: () => Response.json({}) }).fn)).toBe(false); // 200 without an id
    expect(await sendEmail(cfg, msg, fakeFetch({ email: () => Response.json({}, { status: 403 }) }).fn)).toBe(false);
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
    const boom: Limiter = { claim: async () => { throw new Error("db exploded"); } };
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
    expect(m.text).toContain("Partnership Scout: your outreach shortlist");
    expect(m.text).toContain("You clicked Generate on 2026-10-11 17:35 IST");
    expect(m.text).toContain("Data: LIVE, fetched 2026-10-11 17:30 IST");
    expect(m.text).toContain("ranked by upvotes and maker comments");
    expect(m.rows).toBe(10);
    expect(m.text).toContain("#10 Product 10");
    expect(m.text).not.toContain("#11 ");
    expect(m.text).toContain("Full list, filters and draft messages: https://ph-scout.vercel.app");
    expect(m.text).toContain("never change the order");
    expect(m.text).toContain("This copy was sent only to you. Nothing was sent to any founder.");
  });
  it("has rank, name, founders, score, upvotes, maker comments, days, fit, AI-marked angle and link", () => {
    const first = msg().text.split("\n\n").find((b) => b.startsWith("#1 "))!;
    expect(first).toContain("Founders: Founder 1");
    expect(first).toContain("score 89.0");
    expect(first).toContain("99 upvotes");
    expect(first).toContain("11 maker comments");
    expect(first).toContain("launched 3 days ago");
    expect(first).toContain("What it is: x");
    expect(first).toContain("Strong fit");
    expect(first).toContain("Suggested angle (AI): Your tool 1; our standups help");
    expect(first).toContain("https://www.producthunt.com/products/p1");
  });
  it("marks provisional scores and uncounted maker comments", () => {
    const d = data();
    d.ranked[0] = row(1, { provisional: true, makerComments: null });
    const text = buildMessage(d, new Date()).text;
    expect(text).toContain("score 89.0 out of 100 (provisional)");
    expect(text).toContain("maker comments not counted yet");
  });
  it("shows every time in IST (UTC+5:30), including across midnight, and never as UTC", () => {
    expect(ist(new Date("2026-10-11T12:05:00Z"))).toBe("2026-10-11 17:35 IST");
    expect(ist(new Date("2026-10-11T19:00:00Z"))).toBe("2026-10-12 00:30 IST"); // rolls into the next IST day
    const m = buildMessage(data({ fetchedAt: "2026-10-11T19:00:00.000Z" }), new Date("2026-10-11T20:10:00Z"));
    expect(m.text).toContain("You clicked Generate on 2026-10-12 01:40 IST");
    expect(m.text).toContain("fetched 2026-10-12 00:30 IST");
    expect(m.subject).toContain("2026-10-12 01:40 IST");
    expect(m.text + m.html + m.subject).not.toContain("UTC");
  });
  it("says CACHED honestly", () => {
    expect(buildMessage(data({ source: "CACHED" }), new Date()).text).toContain("Data: CACHED (saved copy)");
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
    expect(e.split("\n")[0].length).toBeLessThanOrEqual(100); // "#1 " + name (80) + " (fit label)"
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
  it("never puts secrets or addresses in the notification result", async () => {
    const h = harness();
    const n = await maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn });
    await h.settle();
    for (const secret of ["TESTTOKEN", "re_testkey", "kavya@example.com", "111:"]) expect(JSON.stringify(n)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------- 7. the page can switch channels off (never on)
describe("channel toggle: Telegram and email, both on by default", () => {
  const generate = (h: ReturnType<typeof harness>, wanted?: ("telegram" | "email")[]) =>
    maybeNotify({ generate: true, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, now: h.c.now, wanted });
  const hosts = (h: ReturnType<typeof harness>) => h.f.calls.map((c) => new URL(c.url).host);

  it("sends to both when no choice is made (the default)", async () => {
    const h = harness();
    expect((await generate(h)).channels).toEqual(["telegram", "email"]);
    await h.settle();
    expect(hosts(h)).toEqual(["api.telegram.org", "api.resend.com"]);
  });
  it("sends to both when the page leaves both on", async () => {
    const h = harness();
    await generate(h, ["telegram", "email"]);
    await h.settle();
    expect(hosts(h).sort()).toEqual(["api.resend.com", "api.telegram.org"]);
  });
  it("Telegram only: no email request is made", async () => {
    const h = harness();
    const n = await generate(h, ["telegram"]);
    await h.settle();
    expect(n).toEqual({ status: "sending", channels: ["telegram"] });
    expect(hosts(h)).toEqual(["api.telegram.org"]);
  });
  it("email only: no Telegram request is made", async () => {
    const h = harness();
    const n = await generate(h, ["email"]);
    await h.settle();
    expect(n).toEqual({ status: "sending", channels: ["email"] });
    expect(hosts(h)).toEqual(["api.resend.com"]);
  });
  it("both off: nothing is sent and the 5-minute slot is NOT used", async () => {
    const h = harness();
    const n = await generate(h, []);
    await h.settle();
    expect(n).toEqual({ status: "skipped", channels: [] });
    expect(h.f.calls.length).toBe(0);
    const next = await generate(h); // straight away, with both on: still allowed, because the slot was never claimed
    await h.settle();
    expect(next.status).toBe("sending");
    expect(h.f.calls.length).toBe(2);
  });
  it("the cooldown still applies after a Telegram-only send, whatever channel is chosen next", async () => {
    const h = harness();
    await generate(h, ["telegram"]);
    h.c.advance(60);
    const n = await generate(h, ["email"]);
    expect(n.status).toBe("cooldown");
    expect(n.channels).toEqual(["email"]);
    await h.settle();
    expect(hosts(h)).toEqual(["api.telegram.org"]);
  });
  it("can never add a channel the server has not configured", async () => {
    const h = harness({ env: { ...ENV, RESEND_API_KEY: undefined } }); // email not configured
    const n = await generate(h, ["telegram", "email"]);
    await h.settle();
    expect(n.channels).toEqual(["telegram"]);
    expect(hosts(h)).toEqual(["api.telegram.org"]);
    const onlyEmailWanted = harness({ env: { ...ENV, RESEND_API_KEY: undefined } });
    expect(await generate(onlyEmailWanted, ["email"])).toEqual({ status: "skipped", channels: [] });
    expect(onlyEmailWanted.f.calls.length).toBe(0);
  });
  it("the kill switch still wins over any choice", async () => {
    const h = harness({ env: { ...ENV, NOTIFICATIONS_ENABLED: "false" } });
    expect((await generate(h, ["telegram", "email"])).status).toBe("off");
    expect(h.f.calls.length).toBe(0);
  });
  it("SAMPLE data and Refresh now still never send, whatever the choice", async () => {
    const h = harness();
    const sample = await maybeNotify({ generate: true, data: data({ source: "SAMPLE" }), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, wanted: ["telegram", "email"] });
    expect(sample.status).toBe("skipped_sample");
    const refresh = await maybeNotify({ generate: false, data: data(), env: h.env, limiter: () => h.limiter, schedule: h.schedule, fetchFn: h.f.fn, wanted: ["telegram", "email"] });
    expect(refresh.status).toBe("skipped");
    expect(h.f.calls.length).toBe(0);
  });
});

describe("parseChannels", () => {
  it("accepts only telegram and email, removes duplicates and keeps an explicit empty list", () => {
    expect(parseChannels(["telegram", "email"])).toEqual(["telegram", "email"]);
    expect(parseChannels(["email", "email"])).toEqual(["email"]);
    expect(parseChannels([])).toEqual([]);
  });
  it("treats anything malformed as no choice (everything stays on)", () => {
    for (const bad of [undefined, null, "telegram", 5, {}, ["sms"], ["telegram", "sms"], ["telegram", 1], [null], ["a", "b", "c", "d", "e"]]) {
      expect(parseChannels(bad)).toBeUndefined();
    }
  });
});

describe("channel choice through the POST handler", () => {
  const post = (body: unknown, headers: Record<string, string>) =>
    new Request("https://ph-scout.vercel.app/api/scout", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const browser = { "sec-fetch-site": "same-origin", host: "ph-scout.vercel.app" };
  const run = (h: ReturnType<typeof harness>, req: Request) => handleScout(req, { run: async () => data(), limiter: () => h.limiter, schedule: h.schedule, env: h.env, fetchFn: h.f.fn, now: h.c.now });

  it("honours the choice from a browser request", async () => {
    const h = harness();
    const out = await run(h, post({ channels: ["telegram"] }, browser));
    await h.settle();
    expect(out.notification).toEqual({ status: "sending", channels: ["telegram"] });
    expect(h.f.calls.map((c) => new URL(c.url).host)).toEqual(["api.telegram.org"]);
  });
  it("both off from a browser request sends nothing", async () => {
    const h = harness();
    const out = await run(h, post({ channels: [] }, browser));
    await h.settle();
    expect(out.notification).toEqual({ status: "skipped", channels: [] });
    expect(h.f.calls.length).toBe(0);
  });
  it("garbage in the field leaves the default (both) on", async () => {
    const h = harness();
    const out = await run(h, post({ channels: ["telegram", "sms", { to: "attacker@evil.example" }] }, browser));
    await h.settle();
    expect(out.notification.channels).toEqual(["telegram", "email"]);
    expect(JSON.stringify(h.f.calls.map((c) => c.body))).not.toContain("attacker");
  });
  it("a request without browser headers never sends, so the field cannot make it send", async () => {
    const h = harness();
    const out = await run(h, post({ channels: ["telegram", "email"] }, {}));
    await h.settle();
    expect(out.notification.status).toBe("skipped");
    expect(h.f.calls.length).toBe(0);
  });
  it("the field is ignored for Refresh now (which never sends)", async () => {
    const h = harness();
    const out = await run(h, post({ refresh: true, channels: ["telegram", "email"] }, browser));
    await h.settle();
    expect(out.notification.status).toBe("skipped");
    expect(h.f.calls.length).toBe(0);
  });
});

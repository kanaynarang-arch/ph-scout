import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiRun } from "../lib/gemini";
import type { Launch } from "../lib/types";
import { fakeQuery, store } from "./fake-db";

vi.mock("../lib/db", () => ({ dbConfigured: () => true, query: (t: string, p?: unknown[]) => fakeQuery(t, p), DbError: class extends Error {} }));

process.env.GEMINI_API_KEY = "test";

import { _clearLocks } from "../lib/cache";
import { runScout } from "../lib/pipeline";
import { PhError } from "../lib/producthunt";

const NOW = new Date("2026-10-11T12:00:00Z");
const mk = (id: string, votes: number, comments: number, createdAt = "2026-10-08T07:01:00Z"): Launch => ({
  id, name: `Product ${id}`, tagline: `Tagline for product ${id} here`, description: `Description of product ${id} that does things for teams`,
  slug: `p${id}`, url: `https://www.producthunt.com/products/p${id}`, votesCount: votes, commentsCount: comments, createdAt, featuredAt: null,
  topics: [{ slug: "task-management", name: "Task Management" }], viaSlugs: ["task-management"],
  makers: [{ id: `m${id}`, name: `Maker ${id}`, username: `m${id}` }], hunter: null,
});
const LAUNCHES = [mk("1", 100, 20), mk("2", 50, 10), mk("3", 0, 0, "2026-10-11T07:01:00Z")];

const okGenerate = async (ls: Launch[]): Promise<GeminiRun> => ({
  results: new Map(ls.map((l) => [l.id, { oneLiner: "x", fit: "possible" as const, fitReason: "r", angle: "a", evidenceQuote: "Tagline for product", verified: true }])),
  failed: false, partial: false, calls: 1,
});

beforeEach(() => (store.clear(), _clearLocks()));

describe("runScout", () => {
  it("returns LIVE with a ranked list and a hidden-votes group", async () => {
    const r = await runScout({ now: NOW, deps: {
      fetchLaunches: async () => LAUNCHES,
      countBatch: async (ls) => ({ counts: new Map(ls.map((l) => [l.id, l.id === "1" ? 4 : 8])), stopped: "done" }),
      generate: okGenerate,
    } });
    expect(r.source).toBe("LIVE");
    expect(r.ranked.map((x) => x.id)).toEqual(["1", "2"]); // 75 vs 75: tie, same day, name order
    expect(r.ranked[0].score).toBe(75);
    expect(r.ranked.length).toBe(2);
    expect(r.tooEarly.map((x) => x.id)).toEqual(["3"]);
    expect(r.ranked.every((x) => x.score >= 0)).toBe(true);
  });

  it("falls back to the SAMPLE snapshot when Product Hunt fails and nothing is saved", async () => {
    const r = await runScout({ now: NOW, deps: {
      fetchLaunches: async () => { throw new PhError("bad", "auth"); },
      generate: async () => ({ results: new Map(), failed: true, partial: true, calls: 1 }),
    } });
    expect(r.source).toBe("SAMPLE");
    expect(r.source).not.toBe("LIVE");
    expect(r.warnings.join(" ")).toMatch(/Live Product Hunt data is unavailable/);
  });

  it("shows the AI-unavailable banner and keeps the ranked order when Gemini fails", async () => {
    const deps = (gen: boolean) => ({
      fetchLaunches: async () => LAUNCHES,
      countBatch: async (ls: Launch[]) => ({ counts: new Map(ls.map((l) => [l.id, 3])), stopped: "done" as const }),
      generate: gen ? okGenerate : async (): Promise<GeminiRun> => ({ results: new Map(), failed: true, partial: true, calls: 1 }),
    });
    const bad = await runScout({ now: NOW, deps: deps(false) });
    expect(bad.ai.available).toBe(false);
    expect(bad.warnings[0]).toMatch(/AI summaries unavailable/);
    expect(bad.ranked.every((r) => r.ai.angle === "No angle available — review the launch page")).toBe(true);
    (store.clear(), _clearLocks());
    const good = await runScout({ now: NOW, deps: deps(true) });
    expect(bad.ranked.map((r) => r.id)).toEqual(good.ranked.map((r) => r.id));
  });

  it("serves a stale copy labelled CACHED (never LIVE) when the refresh fails", async () => {
    const deps = { countBatch: async () => ({ counts: new Map<string, number>(), stopped: "done" as const }), generate: okGenerate };
    await runScout({ now: NOW, deps: { ...deps, fetchLaunches: async () => LAUNCHES } });
    // Force a refresh: expire the entry by moving time forward is not possible, so use Refresh now.
    const r = await runScout({ now: NOW, refresh: true, deps: { ...deps, fetchLaunches: async () => { throw new PhError("down", "network"); } } });
    expect(r.source).toBe("CACHED");
    expect(r.warnings.join(" ")).toMatch(/CACHED/);
  });

  it("sends only launches without a saved result to Gemini on the second run", async () => {
    const generate = vi.fn(okGenerate);
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: async (ls: Launch[]) => ({ counts: new Map(ls.map((l) => [l.id, 1])), stopped: "done" as const }), generate };
    const a = await runScout({ now: NOW, deps });
    const b = await runScout({ now: NOW, deps });
    expect(a.ai.sentToGemini).toBeGreaterThan(0);
    expect(b.ai.sentToGemini).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(b.ranked.map((r) => r.ai.angle)).toEqual(a.ranked.map((r) => r.ai.angle));
  });

  it("marks rows not counted as Provisional", async () => {
    const r = await runScout({ now: NOW, deps: {
      fetchLaunches: async () => LAUNCHES,
      countBatch: async () => ({ counts: new Map([["1", 5]]), stopped: "reserve" }),
      generate: okGenerate,
    } });
    const two = r.ranked.find((x) => x.id === "2")!;
    expect(two.makerComments).toBeNull();
    expect(two.provisional).toBe(true);
    expect(r.counted.n).toBeLessThan(r.counted.of);
  });
});

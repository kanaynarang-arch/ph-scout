import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiRun } from "../lib/gemini";
import type { Launch } from "../lib/types";
import { fakeQuery, store } from "./fake-db";

vi.mock("../lib/db", () => ({ dbConfigured: () => true, query: (t: string, p?: unknown[]) => fakeQuery(t, p), DbError: class extends Error {} }));

process.env.GEMINI_API_KEY = "test";
process.env.PH_API_TOKEN = "test-token";

import { _clearLocks, writeMany } from "../lib/cache";
import { RATE_LIMIT_RESERVE } from "../lib/config";
import { runScout } from "../lib/pipeline";
import { countMakerComments, countMakerCommentsBatch, type RateState } from "../lib/producthunt";
import { countingOrder, selectToCount } from "../lib/score";

const NOW = new Date("2026-10-11T12:00:00Z");
const mk = (id: string, votes: number, comments = 5): Launch => ({
  id, name: `Product ${id}`, tagline: `Tagline for product ${id} here`, description: `Description of product ${id} that does things for teams`,
  slug: `p${id}`, url: `https://www.producthunt.com/products/p${id}`, votesCount: votes, commentsCount: comments, createdAt: "2026-10-08T07:01:00Z",
  featuredAt: null, topics: [{ slug: "task-management", name: "Task Management" }], viaSlugs: ["task-management"],
  makers: [{ id: `m${id}`, name: `Maker ${id}`, username: `m${id}` }], hunter: null,
});

describe("countingOrder / selectToCount", () => {
  const list = [mk("a", 10), mk("b", 50), mk("c", 30), mk("d", 50, 9), mk("e", 1)];
  it("orders by potential: a 50/50 blend of upvotes and total comments (upvotes win when comments are equal)", () => {
    expect(countingOrder(list).map((l) => l.id)).toEqual(["d", "b", "c", "a", "e"]);
  });
  it("a quieter launch with a much busier comment thread is counted before a silent one with more upvotes", () => {
    const busy = mk("busy", 40, 90);
    const silent = mk("silent", 60, 2);
    expect(countingOrder([silent, busy]).map((l) => l.id)).toEqual(["busy", "silent"]);
  });
  it("skips launches that already have a valid count", () => {
    expect(selectToCount(list, new Set(["d", "c"]), 10).map((l) => l.id)).toEqual(["b", "a", "e"]);
  });
  it("stops at the cap", () => {
    expect(selectToCount(list, new Set(), 2).map((l) => l.id)).toEqual(["d", "b"]);
    expect(selectToCount(list, new Set(), 0)).toEqual([]);
  });
  it("returns nothing when everything is counted", () => {
    expect(selectToCount(list, new Set(list.map((l) => l.id)), 40)).toEqual([]);
  });
  it("does not mutate the input", () => {
    const before = list.map((l) => l.id).join();
    selectToCount(list, new Set(), 3);
    expect(list.map((l) => l.id).join()).toBe(before);
  });
});

describe("countMakerCommentsBatch stops at the reserve", () => {
  let calls = 0;
  beforeEach(() => {
    calls = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(startRemaining: number) {
    let remaining = startRemaining;
    vi.stubGlobal("fetch", async () => {
      calls++;
      remaining -= 100;
      return new Response(JSON.stringify({ data: { post: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "c", userId: "m1", replies: { nodes: [] } }] } } } }), {
        status: 200,
        headers: { "x-rate-limit-remaining": String(remaining), "content-type": "application/json" },
      });
    });
  }

  it("learns the budget from the first request, then stops at the reserve", async () => {
    stubFetch(RATE_LIMIT_RESERVE + 450);
    const rate: RateState = { remaining: null };
    const launches = Array.from({ length: 12 }, (_, i) => mk(String(i + 1), 100 - i));
    const out = await countMakerCommentsBatch(launches, 40, rate, Date.now() + 60_000);
    expect(out.stopped).toBe("reserve");
    expect(rate.remaining).toBeGreaterThanOrEqual(RATE_LIMIT_RESERVE); // the reserve is never spent
    expect(rate.remaining! - RATE_LIMIT_RESERVE).toBeLessThanOrEqual(100); // and the budget above it is used
    expect(out.counts.size).toBeLessThan(12);
    expect(out.counts.size).toBeGreaterThan(0);
    expect(calls).toBe(out.counts.size);
  });

  it("makes no request at all when the known budget is at the reserve", async () => {
    stubFetch(5000);
    const out = await countMakerCommentsBatch([mk("1", 5)], 40, { remaining: RATE_LIMIT_RESERVE }, Date.now() + 60_000);
    expect(out.counts.size).toBe(0);
    expect(calls).toBe(0);
    expect(out.stopped).toBe("reserve");
  });

  it("with an unknown budget that is already at the reserve, makes only one request", async () => {
    stubFetch(RATE_LIMIT_RESERVE + 50);
    const launches = Array.from({ length: 10 }, (_, i) => mk(String(i + 1), 100 - i));
    await countMakerCommentsBatch(launches, 40, { remaining: null }, Date.now() + 60_000);
    expect(calls).toBe(1);
  });
});

describe("counts accumulate across runs", () => {
  beforeEach(() => (store.clear(), _clearLocks()));

  const LAUNCHES = [mk("1", 100), mk("2", 90), mk("3", 80), mk("4", 70), mk("5", 60), mk("6", 50)];
  const okGenerate = async (ls: Launch[]): Promise<GeminiRun> => ({
    results: new Map(ls.map((l) => [l.id, { oneLiner: "x", fit: "possible" as const, fitReason: "r", angle: "a", evidenceQuote: "Tagline for product", verified: true }])),
    failed: false, partial: false, calls: 1,
  });

  // A fake counter that can only afford `perRun` launches per run (as if the reserve was reached).
  function fakeCounter(perRun: number, seen: string[][]) {
    return async (ls: Launch[]) => {
      seen.push(ls.map((l) => l.id));
      const done = ls.slice(0, perRun);
      return { counts: new Map(done.map((l) => [l.id, 10 + Number(l.id)])), stopped: "reserve" as const };
    };
  }

  it("each run counts only launches without a valid count, highest upvotes first", async () => {
    const seen: string[][] = [];
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: fakeCounter(2, seen), generate: okGenerate };
    const r1 = await runScout({ now: NOW, deps });
    const r2 = await runScout({ now: NOW, deps });
    const r3 = await runScout({ now: NOW, deps });
    expect(seen[0]).toEqual(["1", "2", "3", "4", "5", "6"]); // run 1: everything is a candidate, best first
    expect(seen[1]).toEqual(["3", "4", "5", "6"]); // run 2: skips the two already counted
    expect(seen[2]).toEqual(["5", "6"]); // run 3
    expect([r1.counted.n, r2.counted.n, r3.counted.n]).toEqual([2, 4, 6]);
    const prov = (r: typeof r1) => r.ranked.filter((x) => x.provisional).length;
    expect([prov(r1), prov(r2), prov(r3)]).toEqual([4, 2, 0]);
  });

  it("a launch that gets its count gets its true score; saved counts are not fetched again", async () => {
    const seen: string[][] = [];
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: fakeCounter(3, seen), generate: okGenerate };
    const r1 = await runScout({ now: NOW, deps });
    const r2 = await runScout({ now: NOW, deps });
    const score = (r: typeof r1, id: string) => r.ranked.find((x) => x.id === id)!;
    // Launch 4 was Provisional (no count) in run 1 and has a real count in run 2.
    expect(score(r1, "4").makerComments).toBeNull();
    expect(score(r1, "4").provisional).toBe(true);
    expect(score(r2, "4").makerComments).toBe(14);
    expect(score(r2, "4").provisional).toBe(false);
    // Launches already counted in run 1 kept the same count in run 2 and were not re-fetched.
    expect(score(r2, "1").makerComments).toBe(score(r1, "1").makerComments);
    expect(seen[1]).not.toContain("1");
    // No division by zero and the score is 100 x (0.5V + 0.5M) with M relative to the best count.
    const r = score(r2, "4");
    expect(r.parts.maxMakerComments).toBe(16);
    expect(r.score).toBeCloseTo(100 * (0.5 * (70 / 100) + 0.5 * (14 / 16)), 1);
  });

  it("an expired count that cannot be refreshed is kept but labelled as a saved copy", async () => {
    const deps = {
      fetchLaunches: async () => LAUNCHES,
      countBatch: async () => ({ counts: new Map<string, number>(), stopped: "reserve" as const }), // nothing can be refreshed
      generate: okGenerate,
    };
    await writeMany([{ key: "v1:mc:3", value: 33, ttlMs: -1000 }]); // expired one second ago
    const r = await runScout({ now: NOW, deps });
    const row = r.ranked.find((x) => x.id === "3")!;
    expect(row.makerComments).toBe(33);
    expect(row.makerCommentsStale).toBe(true);
    expect(row.provisional).toBe(false);
    expect(r.counted.stale).toBe(1);
    expect(r.ranked.find((x) => x.id === "1")!.makerCommentsStale).toBe(false);
  });

  it("does not warn about the rate budget when every launch still has a count, even an older saved one", async () => {
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: async () => ({ counts: new Map<string, number>(), stopped: "reserve" as const }), generate: okGenerate };
    await writeMany(["1", "2", "3", "4", "5", "6"].map((id, i) => ({ key: `v1:mc:${id}`, value: 5 + i, ttlMs: -1000 }))); // every launch has an expired saved count
    const r = await runScout({ now: NOW, deps });
    expect(r.ranked.every((x) => !x.provisional)).toBe(true);
    expect(r.warnings.join(" ")).not.toMatch(/not counted yet|Provisional/);
  });

  it("warns, with the number of uncounted launches, when the budget stops counting and rows are really uncounted", async () => {
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: async () => ({ counts: new Map<string, number>(), stopped: "reserve" as const }), generate: okGenerate };
    const r = await runScout({ now: NOW, deps });
    const uncounted = [...r.ranked, ...r.moreLaunches].filter((x) => x.provisional).length;
    expect(uncounted).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toContain(`${uncounted} launches are not counted yet`);
  });

  it("an expired count that CAN be refreshed is refreshed and shown as fresh", async () => {
    const seen: string[][] = [];
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: fakeCounter(6, seen), generate: okGenerate };
    await writeMany([{ key: "v1:mc:3", value: 33, ttlMs: -1000 }]);
    const r = await runScout({ now: NOW, deps });
    expect(seen[0]).toContain("3");
    const row = r.ranked.find((x) => x.id === "3")!;
    expect(row.makerComments).toBe(13);
    expect(row.makerCommentsStale).toBe(false);
    expect(r.counted.stale).toBe(0);
  });

  it("never substitutes an invented number for an uncounted launch", async () => {
    const deps = { fetchLaunches: async () => LAUNCHES, countBatch: async () => ({ counts: new Map<string, number>(), stopped: "reserve" as const }), generate: okGenerate };
    const r = await runScout({ now: NOW, deps });
    expect(r.ranked.every((x) => x.makerComments === null && x.provisional)).toBe(true);
    expect(r.ranked.every((x) => x.score >= 0 && Number.isFinite(x.score))).toBe(true);
    expect(r.counted.n).toBe(0);
  });
});

describe("countMakerComments with makers that the list hides", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (userId: string) => ({ id: `r${userId}`, userId });
  const comment = (userId: string, replies: string[] = []) => ({ id: `c${userId}`, userId, replies: { nodes: replies.map(reply) } });
  const page = (nodes: unknown[], makers?: { id: string }[], hasNextPage = false) => ({ data: { post: { ...(makers ? { makers } : {}), comments: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "x" : null }, nodes } } } });
  const stub = (pages: unknown[]) => {
    const bodies: { variables: Record<string, unknown> }[] = [];
    let i = 0;
    vi.stubGlobal("fetch", async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(pages[Math.min(i++, pages.length - 1)]), { status: 200, headers: { "x-rate-limit-remaining": "5000", "content-type": "application/json" } });
    });
    return bodies;
  };
  const hidden = (): Launch => ({ ...mk("9", 10, 20), makers: [{ id: "0", name: "[REDACTED]", username: "[REDACTED]" }, { id: "0", name: "[REDACTED]", username: "[REDACTED]" }, { id: "m1", name: "Visible Maker", username: "vm" }] });

  it("counts comments and replies by makers the list hid (ids from the post), and never counts the placeholder id 0", async () => {
    stub([page([comment("m1"), comment("m2", ["m3", "zzz"]), comment("0"), comment("other", ["0", "m1"])], [{ id: "m1" }, { id: "m2" }, { id: "m3" }])]);
    // m1 + (m2, reply m3) + (reply m1) = 4; the "0" author and "zzz"/"other" are not makers
    expect(await countMakerComments(hidden(), { remaining: null })).toBe(4);
  });
  it("asks for the full maker list on the first page only", async () => {
    const bodies = stub([page([comment("m2")], [{ id: "m2" }], true), page([comment("m2")])]);
    await countMakerComments(hidden(), { remaining: null });
    expect(bodies.map((b) => b.variables.withMakers)).toEqual([true, false]);
  });
  it("a maker found only on the first page is still counted on later pages", async () => {
    stub([page([comment("m2")], [{ id: "m2" }], true), page([comment("m2"), comment("m2")])]);
    expect(await countMakerComments(hidden(), { remaining: null })).toBe(3);
  });
  it("returns 0 and stops after one request when no maker can be identified at all", async () => {
    const onlyHidden: Launch = { ...hidden(), makers: [{ id: "0", name: "[REDACTED]", username: "[REDACTED]" }] };
    const bodies = stub([page([comment("0"), comment("x")], [], true), page([comment("0")])]);
    expect(await countMakerComments(onlyHidden, { remaining: null })).toBe(0);
    expect(bodies).toHaveLength(1);
  });
  it("makes no request for a launch with no comments or no listed makers", async () => {
    const bodies = stub([page([comment("m1")], [{ id: "m1" }])]);
    expect(await countMakerComments({ ...hidden(), commentsCount: 0 }, { remaining: null })).toBe(0);
    expect(await countMakerComments({ ...hidden(), makers: [] }, { remaining: null })).toBe(0);
    expect(bodies).toHaveLength(0);
  });
});

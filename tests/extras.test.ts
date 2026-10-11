import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_CATEGORIES, categoriesForSlugs, categoryLabel, CATEGORIES, EXTRA_CATEGORIES, MAX_EXTRAS, parseExtras, scannedCategories } from "../lib/categories";
import { fetchLaunches } from "../lib/producthunt";
import { handleScout } from "../lib/scout-handler";
import type { ScoutResponse } from "../lib/types";

describe("optional categories", () => {
  it("are never part of the default scan: the four built-in categories only", () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual(["project-management", "hr-tech", "developer-productivity", "team-communication"]);
    expect(scannedCategories().map((c) => c.id)).toEqual(CATEGORIES.map((c) => c.id));
    expect(scannedCategories([]).length).toBe(4);
  });
  it("parseExtras keeps only known ids, removes duplicates, keeps menu order and caps the count", () => {
    expect(parseExtras(["marketing", "sales"])).toEqual(["sales", "marketing"]);
    expect(parseExtras(["sales", "sales", "bogus", 7, null, "../etc"])).toEqual(["sales"]);
    expect(parseExtras(["sales", "marketing", "analytics", "ai-tools"]).length).toBe(MAX_EXTRAS);
    expect(parseExtras("sales")).toEqual([]);
    expect(parseExtras(undefined)).toEqual([]);
    expect(parseExtras(["project-management"])).toEqual([]); // a built-in id is not an extra
  });
  it("tag a launch only with categories that were scanned", () => {
    const slugs = ["task-management", "sales"];
    expect(categoriesForSlugs(slugs)).toEqual(["project-management"]);
    expect(categoriesForSlugs(slugs, scannedCategories(["sales"]))).toEqual(["project-management", "sales"]);
  });
  it("every extra has a label and at least one topic", () => {
    for (const c of EXTRA_CATEGORIES) {
      expect(categoryLabel(c.id)).toBe(c.label);
      expect(c.slugs.length).toBeGreaterThan(0);
    }
    expect(ALL_CATEGORIES.length).toBe(CATEGORIES.length + EXTRA_CATEGORIES.length);
  });
});

// ---- fetch: only the topics of the categories it is given ----
process.env.PH_API_TOKEN = "test-token";
const NOW = new Date("2026-10-11T12:00:00Z");
const requested: string[] = [];
function raw(id: string, topic: string, votes: number) {
  return { id, name: `P${id}`, tagline: "t", description: "d", slug: `p${id}`, url: `https://www.producthunt.com/products/p${id}`, votesCount: votes, commentsCount: 1, createdAt: "2026-10-08T07:01:00Z", featuredAt: null, user: null, topics: { nodes: [{ slug: topic, name: topic }] }, makers: [] };
}
function stub() {
  requested.length = 0;
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body) as { variables: { topic: string } };
    requested.push(variables.topic);
    const nodes = variables.topic === "sales" ? [raw("900", "sales", 50)] : variables.topic === "task-management" ? [raw("100", "task-management", 40)] : [];
    return new Response(JSON.stringify({ data: { posts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }), { status: 200, headers: { "x-rate-limit-remaining": "6000" } });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("fetchLaunches and extras", () => {
  it("does not ask Product Hunt for any extra topic by default", async () => {
    stub();
    const out = await fetchLaunches(NOW, { remaining: null });
    expect(requested).not.toContain("sales");
    expect(new Set(requested)).toEqual(new Set(CATEGORIES.flatMap((c) => c.slugs)));
    expect(out.map((l) => l.id)).toEqual(["100"]);
  });
  it("asks for an extra topic only when it was switched on, and keeps its launches", async () => {
    stub();
    const out = await fetchLaunches(NOW, { remaining: null }, scannedCategories(["sales"]));
    expect(requested).toContain("sales");
    expect(out.map((l) => l.id).sort()).toEqual(["100", "900"]);
  });
});

// ---- request handling: extras come from the page only, through a fixed menu ----
const resp = { source: "LIVE", ranked: [], tooEarly: [], moreLaunches: [], warnings: [], extras: [] } as unknown as ScoutResponse;
const SAME = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
async function runWith(body: unknown, headers: Record<string, string>) {
  let seen: { refresh?: boolean; extras?: string[] } = {};
  await handleScout(new Request("https://ph-scout.vercel.app/api/scout", { method: "POST", headers, body: JSON.stringify(body) }), {
    run: async (o) => { seen = o ?? {}; return resp; },
    limiter: () => ({ claim: async () => ({ ok: false, reason: "unavailable" as const }) }),
    schedule: () => {}, env: {},
  });
  return seen;
}
describe("handleScout and extras", () => {
  it("passes the validated extras from a browser on this site", async () => {
    expect((await runWith({ extras: ["marketing", "nonsense", "sales", "analytics"] }, SAME)).extras).toEqual(["sales", "marketing"]);
  });
  it("ignores extras from anything that is not a same-origin browser request", async () => {
    expect((await runWith({ extras: ["sales"] }, { "content-type": "application/json" })).extras).toEqual([]);
    expect((await runWith({ extras: ["sales"] }, { "sec-fetch-site": "cross-site", "content-type": "application/json" })).extras).toEqual([]);
  });
  it("still ignores every other field and reads refresh only when it is exactly true", async () => {
    const o = await runWith({ refresh: "yes", topic: "evil", recipients: ["a@b.c"], extras: [] }, SAME);
    expect(o).toEqual({ refresh: false, extras: [] });
  });
});

// ---- the pipeline: the scan, the saved-list key and the response all follow the extras ----
import { runScout } from "../lib/pipeline";
import type { GeminiRun } from "../lib/gemini";
import type { Category } from "../lib/categories";
import type { Launch } from "../lib/types";

const L = (id: string, topic: string, votes: number): Launch => ({
  id, name: `Product ${id}`, tagline: `Tagline for product ${id} here`, description: `Description of product ${id} that does things`, slug: `p${id}`,
  url: `https://www.producthunt.com/products/p${id}`, votesCount: votes, commentsCount: 3, createdAt: "2026-10-08T07:01:00Z", featuredAt: null,
  topics: [{ slug: topic, name: topic }], viaSlugs: [topic], makers: [{ id: `m${id}`, name: `Maker ${id}`, username: `m${id}` }], hunter: null,
});
const noAi = async (ls: Launch[]): Promise<GeminiRun> => ({ results: new Map(), failed: true, partial: true, calls: 1 });

describe("runScout and extras", () => {
  it("scans only the built-in categories by default and reports no extras", async () => {
    let scannedIds: string[] = [];
    const r = await runScout({ now: NOW, deps: {
      fetchLaunches: async (_n: Date, _r: unknown, scanned?: Category[]) => { scannedIds = (scanned ?? []).map((c) => c.id); return [L("1", "task-management", 10), L("2", "sales", 20)]; },
      countBatch: async () => ({ counts: new Map(), stopped: "done" }), generate: noAi,
    } });
    expect(scannedIds).toEqual(["project-management", "hr-tech", "developer-productivity", "team-communication"]);
    expect(r.extras).toEqual([]);
    expect(r.ranked.every((x) => !x.categories.includes("sales" as never))).toBe(true); // a sales topic is not tagged when sales was not scanned
  });
  it("scans a switched-on extra, tags its launches and reports it", async () => {
    let scannedIds: string[] = [];
    const r = await runScout({ now: NOW, extras: ["sales"], deps: {
      fetchLaunches: async (_n: Date, _r: unknown, scanned?: Category[]) => { scannedIds = (scanned ?? []).map((c) => c.id); return [L("1", "task-management", 10), L("2", "sales", 20)]; },
      countBatch: async () => ({ counts: new Map(), stopped: "done" }), generate: noAi,
    } });
    expect(scannedIds).toContain("sales");
    expect(r.extras).toEqual(["sales"]);
    expect(r.ranked.find((x) => x.id === "2")!.categories).toEqual(["sales"]);
  });
  it("falls back to the four main categories, with a note, when live data is unavailable", async () => {
    const { PhError } = await import("../lib/producthunt");
    const r = await runScout({ now: NOW, extras: ["sales"], deps: { fetchLaunches: async () => { throw new PhError("down", "network"); }, generate: noAi } });
    expect(r.source).toBe("SAMPLE");
    expect(r.extras).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/extra categories need live data/i);
  });
});

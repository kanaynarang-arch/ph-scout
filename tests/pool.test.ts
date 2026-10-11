import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLaunches } from "../lib/producthunt";

process.env.PH_API_TOKEN = "test-token";
const NOW = new Date("2026-10-11T12:00:00Z");

// A fake Product Hunt: one big topic (developer-tools) with 100 launches sorted by votes, everything else empty.
function raw(i: number, votes: number, comments: number) {
  return {
    id: String(1000 + i), name: `Launch ${i}`, tagline: `Tagline ${i} for teams`, description: `Description ${i}`, slug: `l${i}`, url: `https://www.producthunt.com/products/l${i}?ref=x`,
    votesCount: votes, commentsCount: comments, createdAt: "2026-10-08T07:01:00Z", featuredAt: null, user: null,
    topics: { nodes: [{ slug: "developer-tools", name: "Developer Tools" }] }, makers: [{ id: `m${i}`, name: `Maker ${i}`, username: `m${i}` }],
  };
}
// votes fall from 500 to 1 across 100 launches; launch 70 (only 31 votes) has a very busy thread (150 comments).
const ALL = Array.from({ length: 100 }, (_, i) => raw(i, 500 - i * 5, i === 70 ? 150 : 2));

function stubFetch() {
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body) as { variables: { topic: string; after: string | null } };
    const nodes = variables.topic === "developer-tools" ? ALL : [];
    const start = variables.after ? Number(variables.after) : 0;
    const slice = nodes.slice(start, start + 20);
    const hasNextPage = start + 20 < nodes.length;
    return new Response(JSON.stringify({ data: { posts: { pageInfo: { hasNextPage, endCursor: String(start + 20) }, nodes: slice } } }), { status: 200, headers: { "x-rate-limit-remaining": "6000" } });
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("fetchLaunches candidate pool", () => {
  it("keeps a lower-voted launch with a very busy comment thread, which a votes-only top-N would cut", async () => {
    stubFetch();
    const out = await fetchLaunches(NOW, { remaining: null });
    const ids = out.map((l) => l.id);
    expect(ids).toContain("1070"); // 31 votes, 150 comments: rank 71 by votes, but high potential
    expect(ids).toContain("1000"); // the top launch by votes is still there
    expect(out.length).toBeLessThanOrEqual(25); // only the developer-productivity category has launches: capped at the per-category limit
  });
  it("reads each topic four pages deep (80 launches), no deeper", async () => {
    stubFetch();
    const out = await fetchLaunches(NOW, { remaining: null });
    // launches 80 to 99 are beyond the page cap, so they can never be candidates
    expect(out.some((l) => Number(l.id) >= 1080)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { daysLeftText } from "../lib/contacted";
import { daysSinceLaunch, scoreAll, sortByScore, sortTooEarly, urgencyFor, votesHidden } from "../lib/score";

const now = new Date("2026-10-11T12:00:00Z");
const L = (id: string, votes: number, mc: number | null, createdAt = "2026-10-08T07:01:00Z", name = id) => ({
  id, name, createdAt, votesCount: votes, makerComments: mc,
});

describe("votesHidden", () => {
  it("hides 0 votes on a launch younger than 6 hours", () => {
    expect(votesHidden({ votesCount: 0, createdAt: "2026-10-11T07:01:00Z" }, now)).toBe(true);
  });
  it("does not hide 0 votes on an older launch", () => {
    expect(votesHidden({ votesCount: 0, createdAt: "2026-10-09T07:01:00Z" }, now)).toBe(false);
  });
  it("does not hide a young launch that has votes", () => {
    expect(votesHidden({ votesCount: 5, createdAt: "2026-10-11T09:00:00Z" }, now)).toBe(false);
  });
});

describe("score", () => {
  it("uses 50/50 shares of the current best", () => {
    const out = scoreAll([L("a", 100, 10), L("b", 50, 10), L("c", 100, 0)]);
    expect(out[0].score).toBe(100);
    expect(out[1].score).toBe(75);
    expect(out[2].score).toBe(50);
  });
  it("handles one launch only", () => {
    expect(scoreAll([L("a", 10, 4)])[0].score).toBe(100);
  });
  it("has no division by zero when nobody has maker comments", () => {
    const out = scoreAll([L("a", 10, 0), L("b", 5, 0)]);
    expect(out.map((o) => o.score)).toEqual([50, 25]);
  });
  it("has no division by zero when everything is zero or empty", () => {
    expect(scoreAll([L("a", 0, 0)])[0].score).toBe(0);
    expect(scoreAll([])).toEqual([]);
  });
  it("treats uncounted maker comments as 0 and marks the score Provisional", () => {
    const out = scoreAll([L("a", 100, 10), L("b", 100, null)]);
    expect(out[1].provisional).toBe(true);
    expect(out[1].score).toBe(50);
    expect(out[0].provisional).toBe(false);
  });
  it("displayed parts add up to the displayed score", () => {
    const out = scoreAll([L("a", 147, 12), L("b", 678, 40), L("c", 33, 7), L("d", 5, null)]);
    for (const o of out) expect(Math.round((o.parts.votesPoints + o.parts.makerPoints) * 10)).toBe(Math.round(o.score * 10));
  });
});

describe("ordering", () => {
  it("sorts by score, then newer launch, then name", () => {
    const rows = [
      { exact: 50, createdAt: "2026-10-08T07:01:00Z", name: "B" },
      { exact: 50, createdAt: "2026-10-09T07:01:00Z", name: "C" },
      { exact: 50, createdAt: "2026-10-08T07:01:00Z", name: "A" },
      { exact: 80, createdAt: "2026-10-05T07:01:00Z", name: "Z" },
    ];
    expect(sortByScore(rows).map((r) => r.name)).toEqual(["Z", "C", "A", "B"]);
  });
  it("ties on a single launch are stable", () => {
    expect(sortByScore([{ exact: 1, createdAt: "2026-10-08T07:01:00Z", name: "A" }]).length).toBe(1);
  });
  it("fit labels and urgency never change the order", () => {
    const base = scoreAll([L("a", 100, 10, "2026-10-11T07:01:00Z"), L("b", 60, 5, "2026-10-04T07:01:00Z"), L("c", 20, 1, "2026-10-08T07:01:00Z")]);
    const order = (fits: Record<string, string>) =>
      sortByScore(base.map((s, i) => ({ ...s, createdAt: ["2026-10-11T07:01:00Z", "2026-10-04T07:01:00Z", "2026-10-08T07:01:00Z"][i], name: s.id, fit: fits[s.id], urgency: urgencyFor(daysSinceLaunch(["2026-10-11T07:01:00Z", "2026-10-04T07:01:00Z", "2026-10-08T07:01:00Z"][i], now)) }))).map((r) => r.id);
    expect(order({ a: "strong", b: "weak", c: "competitor" })).toEqual(order({ a: "competitor", b: "strong", c: "weak" }));
    expect(order({ a: "weak", b: "weak", c: "weak" })).toEqual(["a", "b", "c"]);
  });
  it("orders the too-early group by maker comments then total comments", () => {
    const rows = [
      { name: "x", makerComments: null, commentsCount: 9 },
      { name: "y", makerComments: 2, commentsCount: 1 },
      { name: "z", makerComments: 2, commentsCount: 5 },
    ];
    expect(sortTooEarly(rows).map((r) => r.name)).toEqual(["z", "y", "x"]);
  });
});

describe("urgency boundaries", () => {
  it.each([[0, "hot"], [2, "hot"], [3, "week"], [4, "week"], [5, "closing"], [6, "closing"], [7, "closing"]])("day %i is %s", (d, u) => {
    expect(urgencyFor(d as number)).toBe(u);
  });
  it("a launch is 'closing' exactly when the row's days-left caption says closing (2 or fewer days left)", () => {
    for (let d = 0; d <= 7; d++) expect(urgencyFor(d) === "closing", `day ${d}`).toBe(daysLeftText(d).closing);
  });
  it("counts whole days only", () => {
    expect(daysSinceLaunch("2026-10-08T07:01:00Z", now)).toBe(3);
    expect(daysSinceLaunch("2026-10-11T07:01:00Z", now)).toBe(0);
  });
});

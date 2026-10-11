import { describe, expect, it } from "vitest";
import { csvCell, csvLine, neutraliseFormula, toCsv, CSV_HEADER } from "../lib/csv";
import type { ScoredLaunch } from "../lib/types";

const row = (over: Partial<ScoredLaunch> = {}): ScoredLaunch => ({
  id: "1", name: "Tool", tagline: "t", description: "d", url: "https://www.producthunt.com/products/tool",
  votesCount: 10, commentsCount: 2, createdAt: "2026-10-08T07:01:00Z", makerComments: 3, makerCommentsStale: false,
  votesHidden: false, daysSinceLaunch: 3, urgency: "week", categories: ["hr-tech"],
  founders: { names: ["Ada"], hiddenCount: 1, hunter: null }, score: 55.55, provisional: false,
  parts: { votes: 10, maxVotes: 20, votesShare: 0.5, makerComments: 3, maxMakerComments: 6, makerShare: 0.5, votesPoints: 25, makerPoints: 25 },
  ai: { available: true, oneLiner: "Does things", fit: "strong", fitReason: "r", angle: "Your tool X; our standups Y", evidenceQuote: "does things well", quoteStatus: "verified" },
  firstSeenAt: null, ...over,
});

describe("csvCell", () => {
  it("leaves plain text alone", () => expect(csvCell("hello world")).toBe("hello world"));
  it("quotes cells with commas and doubles inner quotes", () => {
    expect(csvCell('He said "hi", then left')).toBe('"He said ""hi"", then left"');
  });
  it("quotes cells with newlines", () => expect(csvCell("a\nb")).toBe('"a\nb"'));
  it("renders numbers, null and undefined", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("formula injection", () => {
  it.each(["=SUM(A1:A9)", "+1+1", "-2+3", "@cmd", "\tTAB", "\rCR"])("prefixes %j with an apostrophe", (t) => {
    expect(neutraliseFormula(t)).toBe(`'${t}`);
  });
  it("does not touch text that merely contains those characters", () => {
    expect(neutraliseFormula("a=b")).toBe("a=b");
    expect(csvCell("Cash-flow tool")).toBe("Cash-flow tool");
  });
  it("neutralises and still quotes a risky cell with a comma", () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe('"\'=HYPERLINK(""http://x"",""click"")"');
  });
  it("never alters real numbers (a negative number is not text)", () => expect(csvCell(-5)).toBe("-5"));
});

describe("toCsv", () => {
  it("writes the header then one line per row, in the given order, with CRLF endings", () => {
    const csv = toCsv([{ rank: 1, launch: row({ name: "First" }) }, { rank: 2, launch: row({ name: "Second" }) }]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines[1].startsWith("1,First,")).toBe(true);
    expect(lines[2].startsWith("2,Second,")).toBe(true);
    expect(lines[3]).toBe("");
    expect(lines.length).toBe(4);
  });
  it("exports the documented columns", () => {
    const [, line] = toCsv([{ rank: 7, launch: row() }]).split("\r\n");
    expect(line).toBe("7,Tool,Ada (+1 hidden),Does things,10,3,3,55.5,no,Strong fit,Your tool X; our standups Y,does things well,https://www.producthunt.com/products/tool");
  });
  it("says 'not counted' and yes for provisional rows", () => {
    const [, line] = toCsv([{ rank: 1, launch: row({ makerComments: null, provisional: true }) }]).split("\r\n");
    expect(line).toContain(",not counted,");
    expect(line).toContain(",yes,");
  });
  it("handles a row with a comma, a quote and a leading '=' in the data", () => {
    const risky = row({ name: 'Acme, "the" tool', ai: { ...row().ai, angle: '=cmd|"/c calc"', oneLiner: "Line one\nline two" } });
    const [, ...rest] = toCsv([{ rank: 1, launch: risky }]).split("\r\n");
    const line = rest.join("\r\n");
    expect(line).toContain('"Acme, ""the"" tool"');
    expect(line).toContain(`"'=cmd|""/c calc"""`);
    expect(line).toContain('"Line one\nline two"');
  });
  it("leaves rank, score and provisional blank for hidden-vote rows", () => {
    const [, line] = toCsv([{ rank: null, launch: row({ votesHidden: true, votesCount: 0 }) }]).split("\r\n");
    expect(line.startsWith(",Tool,")).toBe(true);
    expect(line).toContain(",votes hidden,");
  });
  it("shows no quote for rows without one", () => {
    const [, line] = toCsv([{ rank: 1, launch: row({ ai: { ...row().ai, quoteStatus: "none", evidenceQuote: null } }) }]).split("\r\n");
    expect(line).toContain("our standups Y,,https://");
  });
  it("csvLine joins cells with commas", () => expect(csvLine(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"'));
});

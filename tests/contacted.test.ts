import { describe, expect, it } from "vitest";
import { daysLeftText, exportContacted, mergeContacted, parseContactedImport } from "../lib/contacted";

describe("daysLeftText", () => {
  it("counts down from the 7-day window and marks the last two days as closing", () => {
    expect(daysLeftText(0)).toEqual({ text: "7 days left", closing: false });
    expect(daysLeftText(4)).toEqual({ text: "3 days left", closing: false });
    expect(daysLeftText(5)).toEqual({ text: "2 days left", closing: true });
    expect(daysLeftText(6)).toEqual({ text: "1 day left", closing: true });
    expect(daysLeftText(7)).toEqual({ text: "window ends today", closing: true });
    expect(daysLeftText(9).closing).toBe(true);
  });
});

describe("contacted export and import", () => {
  const map = { abc: "2026-10-11T10:00:00.000Z", def: "2026-10-12T09:00:00.000Z" };
  it("round-trips through export and import", () => {
    const text = exportContacted(map, { abc: "Velozity" }, new Date("2026-10-12T12:00:00Z"));
    expect(text).toContain("Velozity");
    expect(parseContactedImport(text)).toEqual(map);
  });
  it("rejects files that are not an export, too big, or not JSON", () => {
    expect(parseContactedImport("not json")).toBeNull();
    expect(parseContactedImport(JSON.stringify({ items: "x" }))).toBeNull();
    expect(parseContactedImport(JSON.stringify([1, 2]))).toBeNull();
    expect(parseContactedImport("x".repeat(200_001))).toBeNull();
  });
  it("keeps only plain ids and valid times; ignores names and every other field", () => {
    const text = JSON.stringify({
      items: [
        { id: "ok_1", markedAt: "2026-10-11T10:00:00Z", name: "<script>alert(1)</script>", extra: "x" },
        { id: "bad id!", markedAt: "2026-10-11T10:00:00Z" },
        { id: "__proto__", markedAt: "2026-10-11T10:00:00Z" },
        { id: "no_time" },
        { id: "bad_time", markedAt: "yesterday" },
        { id: 5, markedAt: "2026-10-11T10:00:00Z" },
        null,
      ],
    });
    const out = parseContactedImport(text)!;
    expect(Object.keys(out)).toEqual(["ok_1"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.ok_1).toBe("2026-10-11T10:00:00.000Z");
    expect(JSON.stringify(out)).not.toContain("script");
  });
  it("merges, keeping the earlier time for a launch present in both", () => {
    const merged = mergeContacted({ a: "2026-10-12T00:00:00.000Z" }, { a: "2026-10-11T00:00:00.000Z", b: "2026-10-12T05:00:00.000Z" });
    expect(merged).toEqual({ a: "2026-10-11T00:00:00.000Z", b: "2026-10-12T05:00:00.000Z" });
  });
});

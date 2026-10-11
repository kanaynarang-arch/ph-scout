import { describe, expect, it } from "vitest";
import { quoteIsVerbatim } from "../lib/verify";

const tagline = "The ultimate way to prepare for your job interview";
const description = 'ParakeetAI takes you from "what will they ask?" to "I nailed it." Start with the Question Bank.';

describe("quoteIsVerbatim", () => {
  it("accepts a real quote", () => {
    expect(quoteIsVerbatim("prepare for your job interview", tagline, description)).toBe(true);
  });
  it("rejects a made-up quote", () => {
    expect(quoteIsVerbatim("automates every hiring decision instantly", tagline, description)).toBe(false);
  });
  it("accepts different casing and spacing", () => {
    expect(quoteIsVerbatim("  PREPARE   for your\njob INTERVIEW ", tagline, description)).toBe(true);
  });
  it("rejects a quote shorter than 4 words", () => {
    expect(quoteIsVerbatim("job interview", tagline, description)).toBe(false);
  });
  it("rejects empty or missing quotes", () => {
    expect(quoteIsVerbatim("", tagline, description)).toBe(false);
    expect(quoteIsVerbatim(undefined, tagline, description)).toBe(false);
  });
  it("matches across curly quotes", () => {
    expect(quoteIsVerbatim("from “what will they ask?” to", tagline, description)).toBe(true);
  });
});

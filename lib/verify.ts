import type { GeminiResult } from "./types";

export const NO_ANGLE = "No angle available. Review the launch page";
export const COMPETITOR_ANGLE = "Not a complement. Review before contacting";

export function normalise(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The evidence quote must be a verbatim phrase (4+ words) found in the tagline or description. */
export function quoteIsVerbatim(quote: string | undefined | null, tagline: string, description: string): boolean {
  if (!quote) return false;
  const q = normalise(quote);
  if (q.split(" ").filter(Boolean).length < 4) return false;
  return normalise(`${tagline} ${description}`).includes(q) || normalise(tagline).includes(q) || normalise(description).includes(q);
}

export function isGeminiResult(v: unknown): v is GeminiResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.oneLiner === "string" &&
    typeof r.fitReason === "string" &&
    typeof r.angle === "string" &&
    typeof r.evidenceQuote === "string" &&
    typeof r.verified === "boolean" &&
    ["strong", "possible", "weak", "competitor"].includes(r.fit as string)
  );
}

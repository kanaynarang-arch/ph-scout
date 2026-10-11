import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { PROFILE } from "../config/profile";
import { GEMINI_BATCH_SIZE, GEMINI_DEFAULT_MODEL, GEMINI_TEMPERATURE } from "./config";
import { quoteIsVerbatim } from "./verify";
import type { Fit, GeminiResult, Launch } from "./types";

// Gemini does language work only: fit label, one-liner, outreach angle, evidence quote.
// Input per launch: id, name, tagline, description, topic names. Nothing about people.

export const geminiModel = () => process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

const SYSTEM = `You help Kavya, a partnerships lead, find partnership angles with newly launched products.

Kavya's company profile (use ONLY what it states; do not invent features, customers, integrations or numbers):
"""${PROFILE}"""

For every launch you receive, return one object with:
- id: copy it exactly.
- oneLiner: a plain-English description of what the product does, 18 words or fewer.
- fit: one of strong, possible, weak, competitor. Ask one question: would a partnership between this product and Kavya's product make sense for both sides?
  strong = serves remote or distributed teams and complements async standups (for example project management, team chat, meeting or HR tools a standup tool could integrate with or co-market alongside).
  possible = the audience overlaps with remote teams, but the link to standups is indirect.
  weak = little audience overlap or no clear reason to partner (for example a consumer app or a tool for solo users).
  competitor = it does the same job as an async standup tool.
  Base the rating only on the launch text and the profile above.
- fitReason: why this fit rating, 20 words or fewer.
- angle: how Kavya's product could complement theirs, 30 words or fewer. Name one specific thing the launched product does (the part your evidenceQuote backs) and one specific thing Kavya's product does (from the profile), and say how the second adds to the first. Write it as a suggested opening in Kavya's own voice, speaking to the founder: say "your" for the launched product and "our" for Kavya's product (never "Kavya's product"), for example "Your tool tracks sprint tasks; our async standups would give each task owner a daily update without a meeting." It is a starting point for Kavya, not a finished message. Do not claim integrations, customers or features that are not in the profile.
- evidenceQuote: a verbatim phrase of at least 4 words copied exactly from that launch's tagline or description. Copy it character for character.`;

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING },
      oneLiner: { type: Type.STRING },
      fit: { type: Type.STRING, enum: ["strong", "possible", "weak", "competitor"] },
      fitReason: { type: Type.STRING },
      angle: { type: Type.STRING },
      evidenceQuote: { type: Type.STRING },
    },
    required: ["id", "oneLiner", "fit", "fitReason", "angle", "evidenceQuote"],
    propertyOrdering: ["id", "oneLiner", "fit", "fitReason", "angle", "evidenceQuote"],
  },
};

interface RawResult {
  id: string;
  oneLiner: string;
  fit: Fit;
  fitReason: string;
  angle: string;
  evidenceQuote: string;
}

export type CallFn = (batch: Launch[], signal: AbortSignal) => Promise<RawResult[]>;

const FITS = new Set(["strong", "possible", "weak", "competitor"]);

export const callGemini: CallFn = async (batch, signal) => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const payload = batch.map((l) => ({
    id: l.id,
    name: l.name,
    tagline: l.tagline,
    description: l.description,
    topics: l.topics.map((t) => t.name),
  }));
  const res = await ai.models.generateContent({
    model: geminiModel(),
    contents: `Launches (JSON):\n${JSON.stringify(payload)}`,
    config: {
      systemInstruction: SYSTEM,
      temperature: GEMINI_TEMPERATURE,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      abortSignal: signal,
    },
  });
  const parsed = JSON.parse(res.text ?? "[]");
  if (!Array.isArray(parsed)) throw new Error("Gemini returned a non-array");
  return parsed.filter(
    (r): r is RawResult =>
      r && typeof r.id === "string" && typeof r.oneLiner === "string" && FITS.has(r.fit) && typeof r.angle === "string",
  );
};

function toResult(raw: RawResult, launch: Launch): GeminiResult {
  return {
    oneLiner: raw.oneLiner.trim(),
    fit: raw.fit,
    fitReason: (raw.fitReason ?? "").trim(),
    angle: raw.angle.trim(),
    evidenceQuote: (raw.evidenceQuote ?? "").trim(),
    verified: quoteIsVerbatim(raw.evidenceQuote, launch.tagline, launch.description),
  };
}

export interface GeminiRun {
  results: Map<string, GeminiResult>; // launch id -> result (verified or unverified)
  failed: boolean; // every call failed / nothing returned
  partial: boolean; // some launches got nothing
  calls: number;
}

/**
 * One batched call for launches without a saved result (split into parallel batches of GEMINI_BATCH_SIZE (15) if larger).
 * Launches whose quote fails the check are retried once; then kept and tagged unverified.
 */
export async function generateAngles(launches: Launch[], deadlineAt: number, call: CallFn = callGemini): Promise<GeminiRun> {
  const results = new Map<string, GeminiResult>();
  if (!launches.length) return { results, failed: false, partial: false, calls: 0 };
  const byId = new Map(launches.map((l) => [l.id, l]));
  let calls = 0;
  let anySuccess = false;

  const run = async (batch: Launch[]): Promise<RawResult[]> => {
    calls++;
    const remaining = Math.max(1000, deadlineAt - Date.now());
    try {
      const out = await call(batch, AbortSignal.timeout(remaining));
      anySuccess = true;
      return out;
    } catch {
      return [];
    }
  };

  const batches: Launch[][] = [];
  for (let i = 0; i < launches.length; i += GEMINI_BATCH_SIZE) batches.push(launches.slice(i, i + GEMINI_BATCH_SIZE));
  const first = (await Promise.all(batches.map(run))).flat();
  for (const raw of first) {
    const l = byId.get(raw.id);
    if (l && !results.has(raw.id)) results.set(raw.id, toResult(raw, l));
  }

  // One retry for launches whose quote failed verification.
  const retry = [...results.entries()].filter(([, r]) => !r.verified).map(([id]) => byId.get(id)!);
  if (retry.length && Date.now() < deadlineAt - 3000) {
    const again = (await Promise.all(Array.from({ length: Math.ceil(retry.length / GEMINI_BATCH_SIZE) }, (_, i) => run(retry.slice(i * GEMINI_BATCH_SIZE, (i + 1) * GEMINI_BATCH_SIZE))))).flat();
    for (const raw of again) {
      const l = byId.get(raw.id);
      if (!l) continue;
      const r = toResult(raw, l);
      if (r.verified) results.set(raw.id, r);
    }
  }
  return { results, failed: !anySuccess || results.size === 0, partial: results.size < launches.length, calls };
}

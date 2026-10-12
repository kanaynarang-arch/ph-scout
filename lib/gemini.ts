import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { PROFILE } from "../config/profile";
import { GEMINI_BATCH_SIZE, GEMINI_DEFAULT_MODEL, GEMINI_TEMPERATURE, GOOGLE_CALL_CAP_MS, GOOGLE_CALL_FLOOR_MS } from "./config";
import { primarySignal, withBackup } from "./ai-backup";
import { openrouterJson } from "./openrouter";
import { quoteIsVerbatim } from "./verify";
import type { Fit, GeminiResult, Launch } from "./types";

// Gemini does language work only: fit label, one-liner, outreach angle, evidence quote.
// Input per launch: id, name, tagline, description, topic names. Nothing about people.

export const geminiModel = () => process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY); // the backup route counts: it reaches the same Gemini Flash model
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

/** How long the direct Google call may take: half of the time left (so the backup keeps the other half), between the floor and the cap. */
export const googleCapMs = (remainingMs?: number): number =>
  remainingMs === undefined ? GOOGLE_CALL_CAP_MS : Math.max(GOOGLE_CALL_FLOOR_MS, Math.min(GOOGLE_CALL_CAP_MS, Math.floor(remainingMs / 2)));

export type CallFn = (batch: Launch[], signal: AbortSignal, remainingMs?: number) => Promise<RawResult[]>;

const FITS = new Set(["strong", "possible", "weak", "competitor"]);

/** What the model receives per launch: public launch text only, nothing about people. */
const launchPayload = (batch: Launch[]) =>
  batch.map((l) => ({ id: l.id, name: l.name, tagline: l.tagline, description: l.description, topics: l.topics.map((t) => t.name) }));

const keepValid = (parsed: unknown[]): RawResult[] =>
  parsed.filter(
    (r): r is RawResult =>
      !!r && typeof (r as RawResult).id === "string" && typeof (r as RawResult).oneLiner === "string" && FITS.has((r as RawResult).fit) && typeof (r as RawResult).angle === "string",
  );

// The same schema as a plain JSON Schema (object root) for the OpenRouter backup route.
const BACKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "oneLiner", "fit", "fitReason", "angle", "evidenceQuote"],
        properties: {
          id: { type: "string" },
          oneLiner: { type: "string" },
          fit: { type: "string", enum: ["strong", "possible", "weak", "competitor"] },
          fitReason: { type: "string" },
          angle: { type: "string" },
          evidenceQuote: { type: "string" },
        },
      },
    },
  },
};

async function callGeminiBackup(batch: Launch[], signal: AbortSignal): Promise<RawResult[]> {
  const out = (await openrouterJson({
    system: SYSTEM,
    user: `Launches (JSON):\n${JSON.stringify(launchPayload(batch))}\n\nReturn a JSON object {"results": [...]} with exactly one entry per launch.`,
    schemaName: "launch_angles",
    schema: BACKUP_SCHEMA,
    temperature: GEMINI_TEMPERATURE,
    signal,
  })) as { results?: unknown } | unknown[];
  const list = Array.isArray(out) ? out : out?.results;
  if (!Array.isArray(list)) throw new Error("OpenRouter returned a non-array");
  return keepValid(list);
}

export const callGemini: CallFn = (batch, signal, remainingMs) => withBackup(() => callGoogle(batch, primarySignal(signal, googleCapMs(remainingMs))), () => callGeminiBackup(batch, signal));

const callGoogle: CallFn = async (batch, signal) => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const payload = launchPayload(batch);
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
  return keepValid(parsed);
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
      const out = await call(batch, AbortSignal.timeout(remaining), remaining);
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

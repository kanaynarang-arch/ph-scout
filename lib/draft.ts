import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { PROFILE } from "../config/profile";
import { geminiModel } from "./gemini";
import type { Launch } from "./types";

// "Draft message": Gemini Flash writes a short outbound message that Kavya reviews, edits and sends HERSELF.
// The tool never sends it, never looks up an email and never contacts anyone. Gemini only sees public launch text and
// Kavya's company profile: no maker or commenter names. The greeting carries a placeholder that the page fills in
// from the founder name already shown on screen.

export const DRAFT_VERSION = "d1";
export const FIRST_NAME = "{{first_name}}";

export interface Draft {
  subject: string;
  body: string;
}
export interface DraftSource {
  launch: Launch;
  angle: string; // the saved suggested angle, may be empty
}

const SYSTEM = `You help Kavya, a partnerships lead, write a first outbound message to the founder of a newly launched product.

Kavya's company profile (use ONLY what it states; do not invent features, customers, integrations or numbers):
"""${PROFILE}"""

Write the message in Kavya's own voice. Rules:
- Start the body with exactly this greeting on its own line: Hi ${FIRST_NAME},
- 70 to 110 words, plain and warm, no hype, no flattery, no exclamation marks.
- Mention one specific thing the launched product does, taken from the launch text you are given.
- Say in one sentence how Kavya's product (from the profile) could complement it. You may build on the suggested angle.
- Do not claim Kavya has used the product, and do not claim integrations, customers, results or numbers that are not in the profile.
- End with one low-pressure next step, such as a short call, then sign off with the single word: Kavya
- No links, no email addresses, no emojis, no markdown, no mention of AI.
- subject: 3 to 8 words, specific to this product, no clickbait.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: { subject: { type: Type.STRING }, body: { type: Type.STRING } },
  required: ["subject", "body"],
  propertyOrdering: ["subject", "body"],
};

/** What Gemini receives: public launch text plus the saved angle. Nothing about people. */
export function draftInput(src: DraftSource) {
  const l = src.launch;
  return { name: l.name, tagline: l.tagline, description: l.description, topics: l.topics.map((t) => t.name), suggestedAngle: src.angle };
}

export type DraftCallFn = (src: DraftSource, signal: AbortSignal) => Promise<unknown>;

export const callDraft: DraftCallFn = async (src, signal) => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const res = await ai.models.generateContent({
    model: geminiModel(),
    contents: `Launch (JSON):\n${JSON.stringify(draftInput(src))}`,
    config: {
      systemInstruction: SYSTEM,
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      abortSignal: signal,
    },
  });
  return JSON.parse(res.text ?? "{}");
};

const BAD = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.-]+/i;

/** Checks and cleans the model output. Returns null when it is unusable. */
export function sanitizeDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { subject?: unknown; body?: unknown };
  if (typeof r.subject !== "string" || typeof r.body !== "string") return null;
  const subject = r.subject.replace(/^\s*subject:\s*/i, "").replace(/["“”*`]/g, "").replace(/\s+/g, " ").trim();
  let body = r.body.replace(/\r\n/g, "\n").replace(/[*`#]/g, "").trim();
  if (subject.length < 3 || subject.length > 90) return null;
  if (body.length < 60 || body.length > 1200) return null;
  if (BAD.test(subject) || BAD.test(body)) return null;
  body = body.replace(/\{\s*first[_ ]?name\s*\}|\[\s*(first )?name\s*\]|\{\{\s*first[_ ]?name\s*\}\}/gi, FIRST_NAME);
  if (!body.includes(FIRST_NAME)) {
    body = /^(hi|hello|hey)\b[^\n]*\n/i.test(body) ? body.replace(/^[^\n]*\n/, `Hi ${FIRST_NAME},\n`) : `Hi ${FIRST_NAME},\n\n${body}`;
  }
  if (!/\bkavya\s*$/i.test(body)) body = `${body}\n\nKavya`;
  return { subject, body };
}

/** Only a real browser on this site may ask for a draft (same rule as the copy to Kavya). */
export function isBrowserSameOrigin(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface DraftDeps {
  lookup: (id: string) => Promise<DraftSource | null>;
  draftFor: (src: DraftSource) => Promise<Draft>;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;

export async function handleDraft(req: Request, deps: DraftDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isBrowserSameOrigin(req.headers)) return { status: 403, body: { error: "Drafting is only available from the page." } };
  let id: unknown;
  try {
    const text = await req.text();
    if (text.length > 500) return { status: 400, body: { error: "Bad request." } };
    id = (JSON.parse(text) as { id?: unknown }).id;
  } catch {
    return { status: 400, body: { error: "Bad request." } };
  }
  if (typeof id !== "string" || !ID.test(id)) return { status: 400, body: { error: "Bad request." } };
  let src: DraftSource | null;
  try {
    src = await deps.lookup(id);
  } catch {
    src = null;
  }
  if (!src) return { status: 404, body: { error: "That launch is not in the saved list any more. Click Refresh now and try again." } };
  try {
    const d = await deps.draftFor(src);
    return { status: 200, body: { subject: d.subject, body: d.body } };
  } catch {
    return { status: 503, body: { error: "Drafting is unavailable right now. Please try again." } };
  }
}

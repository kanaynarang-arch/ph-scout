import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { PROFILE } from "../config/profile";
import { primarySignal, withBackup } from "./ai-backup";
import { geminiModel } from "./gemini";
import { openrouterJson } from "./openrouter";
import { parseExtras, type ExtraCategoryId } from "./categories";
import { isBrowserSameOrigin } from "./origin";
import type { Launch } from "./types";

// "Draft message": Gemini Flash writes a short outbound message that Kavya reviews, edits and sends HERSELF.
// The tool never sends it, never looks up an email and never contacts anyone. Gemini only sees public launch text and
// Kavya's company profile: no maker or commenter names. The greeting carries a placeholder that the page fills in
// from the founder name already shown on screen.

export const DRAFT_VERSION = "d2";
export type DraftChannel = "email" | "dm"; // a first email (with a subject) or a short direct message (LinkedIn or Product Hunt)
export const FIRST_NAME = "{{first_name}}";

export interface Draft {
  subject: string;
  body: string;
}
export interface DraftSource {
  launch: Launch;
  angle: string; // the saved suggested angle, may be empty
}

const BASE = `You help Kavya, a partnerships lead, write a first outbound message to the founder of a newly launched product.

Kavya's company profile (use ONLY what it states; do not invent features, customers, integrations or numbers):
"""${PROFILE}"""

Write the message in Kavya's own voice. Rules:
- Start the body with exactly this greeting on its own line: Hi ${FIRST_NAME},
- WORDS_RULE, plain and warm, no hype, no flattery, no exclamation marks.
- Mention one specific thing the launched product does, taken from the launch text you are given.
- Say in one sentence how Kavya's product (from the profile) could complement it. You may build on the suggested angle.
- Do not claim Kavya has used the product, and do not claim integrations, customers, results or numbers that are not in the profile.
- End with one low-pressure next step, such as a short call, then sign off with the single word: Kavya
- No links, no email addresses, no emojis, no markdown, no mention of AI.
- SUBJECT_RULE`;

const WORDS = { email: "70 to 110 words", dm: "40 to 65 words, short and conversational like a LinkedIn or Product Hunt direct message" } as const;
const SUBJECT = { email: "subject: 3 to 8 words, specific to this product, no clickbait.", dm: "subject: return the single word DM (it is not used)." } as const;
const systemFor = (channel: DraftChannel) => BASE.replace("WORDS_RULE", WORDS[channel]).replace("SUBJECT_RULE", SUBJECT[channel]);

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

export type DraftCallFn = (src: DraftSource, signal: AbortSignal, channel?: DraftChannel) => Promise<unknown>;

const BACKUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: { subject: { type: "string" }, body: { type: "string" } },
};

export const callDraft: DraftCallFn = (src, signal, channel = "email") =>
  withBackup(
    () => callDraftGoogle(src, primarySignal(signal, 12_000), channel),
    () => openrouterJson({ system: systemFor(channel), user: `Launch (JSON):\n${JSON.stringify(draftInput(src))}`, schemaName: "outreach_draft", schema: BACKUP_SCHEMA, temperature: 0.4, signal }),
  );

const callDraftGoogle: DraftCallFn = async (src, signal, channel = "email") => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const res = await ai.models.generateContent({
    model: geminiModel(),
    contents: `Launch (JSON):\n${JSON.stringify(draftInput(src))}`,
    config: {
      systemInstruction: systemFor(channel),
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
export function sanitizeDraft(raw: unknown, channel: DraftChannel = "email"): Draft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { subject?: unknown; body?: unknown };
  if (typeof r.subject !== "string" || typeof r.body !== "string") return null;
  const dm = channel === "dm";
  const subject = dm ? "" : r.subject.replace(/^\s*subject:\s*/i, "").replace(/["“”*`]/g, "").replace(/\s+/g, " ").trim();
  let body = r.body.replace(/\r\n/g, "\n").replace(/[*`#]/g, "").trim();
  if (!dm && (subject.length < 3 || subject.length > 90)) return null;
  if (body.length < (dm ? 40 : 60) || body.length > (dm ? 800 : 1200)) return null;
  if (BAD.test(subject) || BAD.test(body)) return null;
  body = body.replace(/\{\s*first[_ ]?name\s*\}|\[\s*(first )?name\s*\]|\{\{\s*first[_ ]?name\s*\}\}/gi, FIRST_NAME);
  if (!body.includes(FIRST_NAME)) {
    body = /^(hi|hello|hey)\b[^\n]*\n/i.test(body) ? body.replace(/^[^\n]*\n/, `Hi ${FIRST_NAME},\n`) : `Hi ${FIRST_NAME},\n\n${body}`;
  }
  if (!/\bkavya\s*$/i.test(body)) body = `${body}\n\nKavya`;
  return { subject, body };
}

export { isBrowserSameOrigin } from "./origin";

export interface DraftDeps {
  lookup: (id: string, extras?: ExtraCategoryId[]) => Promise<DraftSource | null>;
  draftFor: (src: DraftSource, channel: DraftChannel) => Promise<Draft>;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;

export async function handleDraft(req: Request, deps: DraftDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!isBrowserSameOrigin(req.headers)) return { status: 403, body: { error: "Drafting is only available from the page." } };
  let id: unknown;
  let channel: DraftChannel = "email";
  let extras: ExtraCategoryId[] = [];
  try {
    const text = await req.text();
    if (text.length > 500) return { status: 400, body: { error: "Bad request." } };
    const parsed = JSON.parse(text) as { id?: unknown; channel?: unknown; extras?: unknown };
    id = parsed.id;
    if (parsed.channel === "dm") channel = "dm"; // anything other than "dm" means email
    extras = parseExtras(parsed.extras); // only ids from the fixed menu, so the launch can be found in an extra-category list
  } catch {
    return { status: 400, body: { error: "Bad request." } };
  }
  if (typeof id !== "string" || !ID.test(id)) return { status: 400, body: { error: "Bad request." } };
  let src: DraftSource | null;
  try {
    src = await deps.lookup(id, extras);
  } catch {
    src = null;
  }
  if (!src) return { status: 404, body: { error: "That launch is not in the saved list any more. Click Refresh now and try again." } };
  try {
    const d = await deps.draftFor(src, channel);
    return { status: 200, body: { subject: d.subject, body: d.body, channel } };
  } catch {
    return { status: 503, body: { error: "Drafting is unavailable right now. Please try again." } };
  }
}

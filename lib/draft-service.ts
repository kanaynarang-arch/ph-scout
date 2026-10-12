import { createHash } from "node:crypto";
import { PROFILE } from "../config/profile";
import { getOrRefresh, key, readMany } from "./cache";
import { TTL_GEMINI_MS } from "./config";
import type { ExtraCategoryId } from "./categories";
import { callDraft, DRAFT_VERSION, sanitizeDraft, type Draft, type DraftChannel, type DraftSource } from "./draft";
import { geminiConfigured } from "./gemini";
import { geminiKey, isLaunchArray } from "./pipeline";
import { loadSnapshot } from "./snapshot";
import { isGeminiResult } from "./verify";
import type { GeminiResult, Launch } from "./types";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const isDraft = (v: unknown): v is Draft => !!v && typeof (v as Draft).subject === "string" && typeof (v as Draft).body === "string";

/** Finds the launch (and its saved angle) from the saved list in Neon, falling back to the bundled snapshot. */
export async function lookupSource(id: string, extras: ExtraCategoryId[] = []): Promise<DraftSource | null> {
  const snap = loadSnapshot();
  let launch: Launch | undefined;
  let angle = "";
  try {
    const keys = extras.length ? [key("launches"), key("launches", "x", extras.join("+"))] : [key("launches")];
    const saved = await readMany<Launch[]>(keys, isLaunchArray);
    for (const k of keys) {
      launch = saved.entries.get(k)?.value.find((l) => l.id === id);
      if (launch) break;
    }
    if (launch) {
      const g = await readMany<GeminiResult>([geminiKey(launch)], isGeminiResult);
      angle = g.entries.get(geminiKey(launch))?.value.angle ?? "";
    }
  } catch {
    /* fall through to the snapshot */
  }
  if (!launch) {
    launch = snap.launches.find((l) => l.id === id);
    if (launch) angle = snap.gemini[id]?.angle ?? "";
  }
  return launch ? { launch, angle } : null;
}

/** One Gemini Flash call per launch, saved in Neon for 7 days so repeat clicks cost nothing. */
export async function draftFor(src: DraftSource, channel: DraftChannel = "email"): Promise<Draft> {
  if (!geminiConfigured()) throw new Error("Gemini is not configured");
  const l = src.launch;
  const k = key("draft", DRAFT_VERSION, channel, sha(PROFILE), l.id, sha(`${l.name}\n${l.tagline}\n${l.description}\n${src.angle}`));
  const r = await getOrRefresh<Draft>({
    key: k,
    ttlMs: TTL_GEMINI_MS,
    validate: isDraft,
    lockName: `draft:${l.id}`,
    fetcher: async () => {
      const d = sanitizeDraft(await callDraft(src, AbortSignal.timeout(25_000), channel), channel);
      if (!d) throw new Error("Unusable draft");
      return d;
    },
  });
  return r.value;
}

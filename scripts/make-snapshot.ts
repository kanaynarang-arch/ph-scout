// Builds data/snapshot.json from the REAL live data currently saved in Neon (launch list, maker counts,
// Gemini results). Refuses to run unless that list came from a live Product Hunt fetch.
import { writeFileSync } from "node:fs";
import { key, readMany } from "../lib/cache";
import { geminiKey } from "../lib/pipeline";
import { isGeminiResult } from "../lib/verify";
import type { GeminiResult, Launch } from "../lib/types";

const list = await readMany<Launch[]>([key("launches")], (v): v is Launch[] => Array.isArray(v));
const entry = list.entries.get(key("launches"));
if (!entry) throw new Error("No saved launch list. Run Generate against live data first.");
const launches = entry.value;
const counts = await readMany<number>(launches.map((l) => key("mc", l.id)), (v): v is number => typeof v === "number");
const gem = await readMany<GeminiResult>(launches.map(geminiKey), isGeminiResult);

const makerCounts: Record<string, number | null> = {};
const gemini: Record<string, GeminiResult> = {};
for (const l of launches) {
  const c = counts.entries.get(key("mc", l.id));
  makerCounts[l.id] = c ? c.value : l.commentsCount === 0 || l.makers.length === 0 ? 0 : null;
  const g = gem.entries.get(geminiKey(l));
  if (g) gemini[l.id] = g.value;
}
const snapshot = { fetchedAt: entry.fetchedAt, launches, makerCounts, gemini };
writeFileSync(new URL("../data/snapshot.json", import.meta.url), JSON.stringify(snapshot));
console.log(`snapshot: ${launches.length} launches, ${Object.values(makerCounts).filter((v) => v !== null).length} counts, ${Object.keys(gemini).length} AI results, fetchedAt ${entry.fetchedAt}`);

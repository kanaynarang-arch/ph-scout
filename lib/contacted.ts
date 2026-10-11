import { WINDOW_DAYS } from "./config";

// Browser-only helpers for Kavya's "contacted" notes and the days-left caption. Nothing here is sent anywhere.

/** Short caption for how much of the 7-day outreach window is left. Launch time is day-level, so this is approximate. */
export function daysLeftText(daysSinceLaunch: number, windowDays = WINDOW_DAYS): { text: string; closing: boolean } {
  const left = windowDays - Math.max(0, daysSinceLaunch);
  if (left <= 0) return { text: "window ends today", closing: true };
  if (left === 1) return { text: "1 day left", closing: true };
  return { text: `${left} days left`, closing: left <= 2 };
}

export type ContactedMap = Record<string, string>; // launch id -> ISO time Kavya marked it

const ID = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_IMPORT_BYTES = 200_000;
export const MAX_CONTACTED = 2000;

/** The file Kavya downloads: readable (names and dates) and importable again. Only her own notes. */
export function exportContacted(contacted: ContactedMap, names: Record<string, string>, now: Date = new Date()): string {
  const items = Object.entries(contacted)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, markedAt]) => ({ id, name: names[id] ?? null, markedAt }));
  return JSON.stringify({ app: "ph-scout", kind: "contacted", exportedAt: now.toISOString(), items }, null, 2);
}

/**
 * Reads a file produced by exportContacted. Strict on purpose: only the id (a plain token) and the time are kept; names
 * and every other field are ignored; anything malformed is dropped. Returns null when the file is not usable.
 */
export function parseContactedImport(text: string): ContactedMap | null {
  if (text.length > MAX_IMPORT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  const out: ContactedMap = {};
  for (const it of items.slice(0, MAX_CONTACTED)) {
    const id = (it as { id?: unknown } | null)?.id;
    const at = (it as { markedAt?: unknown } | null)?.markedAt;
    if (typeof id !== "string" || !ID.test(id) || id === "__proto__" || typeof at !== "string") continue;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) continue;
    out[id] = new Date(t).toISOString();
  }
  return out;
}

/** Merge an import into what is already saved; when both have a launch, the earlier time wins. */
export function mergeContacted(current: ContactedMap, incoming: ContactedMap): ContactedMap {
  const next = { ...current };
  for (const [id, at] of Object.entries(incoming)) {
    if (!next[id] || at < next[id]) next[id] = at;
  }
  return next;
}

import snapshotJson from "../data/snapshot.json";
import type { GeminiResult, Launch } from "./types";

export interface Snapshot {
  fetchedAt: string;
  launches: Launch[];
  makerCounts: Record<string, number | null>;
  gemini: Record<string, GeminiResult>;
}

export function loadSnapshot(): Snapshot {
  return snapshotJson as unknown as Snapshot;
}

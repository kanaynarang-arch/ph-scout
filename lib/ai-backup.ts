import { openrouterConfigured } from "./openrouter";

/**
 * Runs the direct Google call first. If it fails (invalid key, quota, outage) and a backup route is configured, runs the backup
 * (the same Gemini Flash model through OpenRouter). With no Google key at all, goes straight to the backup. If both fail, the
 * ORIGINAL error is thrown, so callers see the same failure as before and their "AI unavailable" handling is unchanged.
 */
export async function withBackup<T>(primary: () => Promise<T>, backup: () => Promise<T>, backupConfigured: boolean = openrouterConfigured()): Promise<T> {
  if (!process.env.GEMINI_API_KEY && backupConfigured) return backup();
  try {
    return await primary();
  } catch (first) {
    if (!backupConfigured) throw first;
    try {
      const out = await backup();
      console.log("ai backup used"); // outcome only: no key, no text
      return out;
    } catch {
      throw first;
    }
  }
}

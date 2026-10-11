import { createHash } from "node:crypto";
import { PROFILE } from "../config/profile";
import { scannedCategories, type Category, type ExtraCategoryId } from "./categories";
import { categoriesOf, daysSinceLaunch, founderInfo, safeSiteUrl, scoreAll, selectToCount, sortByScore, sortTooEarly, urgencyFor, votesHidden } from "./score";
import {
  GEMINI_HIDDEN_EXTRA,
  GEMINI_TOP_N,
  MAKER_COMMENT_K,
  COUNT_PHASE_DEADLINE_MS,
  PROMPT_VERSION,
  REFRESH_NOW_COOLDOWN_MS,
  TOTAL_DEADLINE_MS,
  TTL_COUNTS_MS,
  TTL_GEMINI_MS,
  TTL_LIST_MS,
  WINDOW_DAYS,
} from "./config";
import { acquireLock, getOrRefresh, key, lockExpiry, readMany, writeMany } from "./cache";
import { dbConfigured, query } from "./db";
import { generateAngles, geminiConfigured, geminiModel } from "./gemini";
import { countMakerCommentsBatch, fetchLaunches, PhError, type CountOutcome, type RateState } from "./producthunt";
import { loadSnapshot } from "./snapshot";
import { COMPETITOR_ANGLE, isGeminiResult, NO_ANGLE } from "./verify";
import type { GeminiResult, Launch, ScoredLaunch, ScoutResponse, Source } from "./types";

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const PROFILE_HASH = sha(PROFILE);
const contentHash = (l: Launch) => sha(`${l.name}\n${l.tagline}\n${l.description}`);
export const geminiKey = (l: Launch) => key("gem", PROMPT_VERSION, PROFILE_HASH, l.id, contentHash(l));
const countKey = (id: string) => key("mc", id);

export const isLaunchArray = (v: unknown): v is Launch[] =>
  Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as Launch).id === "string" && typeof (x as Launch).name === "string" && Array.isArray((x as Launch).makers));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export interface Deps {
  fetchLaunches: typeof fetchLaunches;
  countBatch: typeof countMakerCommentsBatch;
  generate: typeof generateAngles;
}
const realDeps: Deps = { fetchLaunches, countBatch: countMakerCommentsBatch, generate: generateAngles };

export interface RunOptions {
  refresh?: boolean; // "Refresh now" button
  extras?: ExtraCategoryId[]; // optional extra categories to scan on top of the four built-in ones (already validated)
  now?: Date;
  deps?: Partial<Deps>;
}

function phReason(e: unknown): string {
  if (e instanceof PhError) {
    if (e.kind === "auth" || e.kind === "missing-token") return "the Product Hunt token was rejected or missing";
    if (e.kind === "rate") return "the Product Hunt rate limit was reached";
    if (e.kind === "network") return "Product Hunt could not be reached";
    return "Product Hunt returned an error";
  }
  return "Product Hunt returned an error";
}

function buildRow(
  l: Launch,
  makerComments: number | null,
  asOf: Date,
  hidden: boolean,
  scored: { score: number; provisional: boolean; parts: ScoredLaunch["parts"] } | null,
  ai: GeminiResult | undefined,
  withAi: boolean,
  firstSeenAt: string | null,
  makerCommentsStale: boolean,
  scanned: Category[],
): ScoredLaunch {
  const days = daysSinceLaunch(l.createdAt, asOf);
  let aiBlock: ScoredLaunch["ai"];
  if (ai && withAi) {
    const comp = ai.fit === "competitor";
    aiBlock = {
      available: true,
      oneLiner: ai.oneLiner,
      fit: ai.fit,
      fitReason: ai.fitReason,
      angle: comp ? COMPETITOR_ANGLE : ai.angle,
      evidenceQuote: comp ? null : ai.evidenceQuote,
      quoteStatus: comp ? "none" : ai.verified ? "verified" : "unverified",
    };
  } else {
    aiBlock = { available: false, oneLiner: l.tagline, fit: "unrated", fitReason: "", angle: withAi ? NO_ANGLE : "", evidenceQuote: null, quoteStatus: "none" };
  }
  return {
    id: l.id,
    name: l.name,
    tagline: l.tagline,
    description: l.description,
    url: l.url,
    votesCount: l.votesCount,
    commentsCount: l.commentsCount,
    createdAt: l.createdAt,
    makerComments,
    makerCommentsStale,
    votesHidden: hidden,
    daysSinceLaunch: days,
    urgency: urgencyFor(days),
    categories: categoriesOf(l, scanned),
    founders: founderInfo(l),
    websiteUrl: safeSiteUrl(l.website),
    score: scored?.score ?? 0,
    provisional: scored?.provisional ?? false,
    parts:
      scored?.parts ??
      { votes: l.votesCount, maxVotes: 0, votesShare: 0, makerComments, maxMakerComments: 0, makerShare: 0, votesPoints: 0, makerPoints: 0 },
    ai: aiBlock,
    firstSeenAt,
  };
}

async function recordFirstSeen(ids: string[]): Promise<Map<string, string> | null> {
  if (!dbConfigured() || !ids.length) return null;
  try {
    await query("INSERT INTO launch_seen (launch_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [ids]);
    const rows = await query<{ launch_id: string; first_seen_at: string }>(
      "SELECT launch_id, first_seen_at FROM launch_seen WHERE launch_id = ANY($1::text[])",
      [ids],
    );
    return new Map(rows.map((r) => [r.launch_id, new Date(r.first_seen_at).toISOString()]));
  } catch {
    return null;
  }
}

export async function runScout(opts: RunOptions = {}): Promise<ScoutResponse> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const deps = { ...realDeps, ...opts.deps };
  const totalDeadline = t0 + TOTAL_DEADLINE_MS;
  const warnings: string[] = [];
  const rate: RateState = { remaining: null };
  let dbProblem = false;

  // ---- Refresh now: at most once per 5 minutes, enforced in Neon across instances ----
  let force = false;
  let refreshApplied = false;
  let nextAvailableAt: string | null = null;
  if (opts.refresh) {
    if (await acquireLock("refresh-now", REFRESH_NOW_COOLDOWN_MS)) {
      force = true;
      refreshApplied = true;
      nextAvailableAt = new Date(Date.now() + REFRESH_NOW_COOLDOWN_MS).toISOString();
    } else {
      const exp = await lockExpiry("refresh-now");
      nextAvailableAt = exp ? new Date(exp).toISOString() : null;
      warnings.push("Refresh now is limited to once every 5 minutes, so saved data is shown instead.");
    }
  } else {
    const exp = await lockExpiry("refresh-now");
    nextAvailableAt = exp ? new Date(exp).toISOString() : null;
  }

  // ---- 1. Launch list: Neon (1 hour) -> live Product Hunt -> stale copy -> bundled snapshot ----
  // The default (four built-in categories) keeps its own saved list; each extra combination gets a separate saved list.
  const extras = opts.extras ?? [];
  let scanned = scannedCategories(extras);
  const listKey = extras.length ? key("launches", "x", extras.join("+")) : key("launches");
  let launches: Launch[];
  let source: Source;
  let fetchedAt: string;
  let listStatus: "fresh" | "refreshed" | "stale" | "sample";
  const snapshot = loadSnapshot();
  try {
    const r = await getOrRefresh<Launch[]>({
      key: listKey,
      ttlMs: TTL_LIST_MS,
      validate: isLaunchArray,
      fetcher: () => deps.fetchLaunches(now, rate, scanned),
      force,
      lockName: extras.length ? `launches:${extras.join("+")}` : "launches",
    });
    launches = r.value;
    fetchedAt = r.fetchedAt;
    listStatus = r.status;
    source = r.status === "stale" ? "CACHED" : "LIVE";
    if (r.dbError) dbProblem = true;
    if (r.status === "stale") warnings.push(`Product Hunt could not be refreshed, so the saved copy from ${fetchedAt} is shown (CACHED).`);
  } catch (e) {
    launches = snapshot.launches;
    fetchedAt = snapshot.fetchedAt;
    listStatus = "sample";
    source = "SAMPLE";
    scanned = scannedCategories([]);
    warnings.push(`Live Product Hunt data is unavailable (${phReason(e)}). Showing the bundled SAMPLE from ${snapshot.fetchedAt.slice(0, 10)}.`);
    if (extras.length) warnings.push("The extra categories need live data, so only the four main categories are shown.");
  }
  // LIVE data is measured against now; CACHED/SAMPLE against the time they were fetched.
  const asOf = source === "LIVE" ? now : new Date(fetchedAt);
  if (source === "LIVE") {
    const start = now.getTime() - WINDOW_DAYS * 86_400_000;
    launches = launches.filter((l) => Date.parse(l.createdAt) >= start);
  }

  const hiddenSet = new Set(launches.filter((l) => votesHidden(l, asOf)).map((l) => l.id));

  // ---- 2. Maker comments: saved counts (6 hours), then fetch down the ranked list within the rate budget ----
  const counts = new Map<string, number>();
  const staleCounts = new Set<string>(); // counts that come from an expired saved copy (shown as CACHED)
  let countStop: CountOutcome["stopped"] | null = null; // why counting ended early, if it did; turned into a warning below
  if (source === "SAMPLE") {
    for (const [id, c] of Object.entries(snapshot.makerCounts)) if (typeof c === "number") counts.set(id, c);
  } else {
    // Launches with no comments or no makers need no API call.
    for (const l of launches) if (l.commentsCount === 0 || l.makers.length === 0) counts.set(l.id, 0);
    const saved = await readMany<number>(launches.map((l) => countKey(l.id)), isCount);
    if (saved.dbError) dbProblem = true;
    const stale = new Map<string, number>();
    for (const l of launches) {
      if (counts.has(l.id)) continue;
      const e = saved.entries.get(countKey(l.id));
      if (!e) continue;
      if (Date.parse(e.expiresAt) > Date.now()) counts.set(l.id, e.value);
      else stale.set(l.id, e.value);
    }
    if (listStatus !== "stale") {
      // Counts accumulate: only launches without a valid saved count are fetched, most upvotes first,
      // until the per-run cap, the rate-limit reserve or the time limit is reached.
      const toFetch = selectToCount(launches, new Set(counts.keys()), MAKER_COMMENT_K);
      if (toFetch.length) {
        const out: CountOutcome = await deps.countBatch(toFetch, MAKER_COMMENT_K, rate, Math.min(t0 + COUNT_PHASE_DEADLINE_MS, totalDeadline));
        const fresh = [...out.counts.entries()];
        for (const [id, c] of fresh) counts.set(id, c);
        await writeMany(fresh.map(([id, c]) => ({ key: countKey(id), value: c, ttlMs: TTL_COUNTS_MS })));
        countStop = out.stopped;
      }
    }
    // An expired saved count that could not be refreshed is kept, but labelled as a saved copy (CACHED).
    for (const [id, c] of stale) {
      if (counts.has(id)) continue;
      counts.set(id, c);
      staleCounts.add(id);
    }
    // Only warn when rows really are uncounted (Provisional). If every launch has a count, even an older saved one, there is nothing to warn about.
    const uncounted = launches.filter((l) => !counts.has(l.id) && !hiddenSet.has(l.id)).length;
    if (uncounted > 0 && (countStop === "reserve" || countStop === "rate-limit")) {
      warnings.push(`Product Hunt limits how fast maker comments can be counted, so ${uncounted} ${uncounted === 1 ? "launch is" : "launches are"} not counted yet. ${uncounted === 1 ? "It is" : "They are"} marked Provisional (the score can only go up) and fill in automatically on the next refresh.`);
    } else if (uncounted > 0 && (countStop === "deadline" || countStop === "error")) {
      warnings.push(`Not every maker-comment count finished in time or one request failed, so ${uncounted} ${uncounted === 1 ? "launch is" : "launches are"} Provisional and will fill in on the next run.`);
    }
  }

  // ---- 3. Score in code: upvotes and maker comments only ----
  const visible = launches.filter((l) => !hiddenSet.has(l.id));
  const hidden = launches.filter((l) => hiddenSet.has(l.id));
  const mc = (l: Launch) => (counts.has(l.id) ? counts.get(l.id)! : null);
  const scoredList = scoreAll(visible.map((l) => ({ id: l.id, name: l.name, createdAt: l.createdAt, votesCount: l.votesCount, makerComments: mc(l) })));
  const scoreById = new Map(scoredList.map((s) => [s.id, s]));
  const rankedLaunches = sortByScore(visible.map((l) => ({ l, ...scoreById.get(l.id)!, name: l.name, createdAt: l.createdAt })));
  const topRanked = rankedLaunches.slice(0, GEMINI_TOP_N).map((x) => x.l);
  const moreRanked = rankedLaunches.slice(GEMINI_TOP_N).map((x) => x.l);
  const tooEarlyLaunches = sortTooEarly(hidden.map((l) => ({ l, makerComments: mc(l), commentsCount: l.commentsCount, name: l.name })));
  const tooEarly = tooEarlyLaunches.map((x) => x.l);

  // ---- 4. Gemini: only launches with no saved result are sent ----
  const targets = [...topRanked, ...tooEarly.slice(0, GEMINI_HIDDEN_EXTRA)];
  const results = new Map<string, GeminiResult>();
  let reused = 0;
  let sent = 0;
  let aiAvailable = true;
  const aiPhase = async () => {
    if (source === "SAMPLE") {
      for (const l of targets) {
        const g = snapshot.gemini[l.id];
        if (g && isGeminiResult(g)) results.set(l.id, g);
      }
    }
    const saved = await readMany<GeminiResult>(targets.map(geminiKey), isGeminiResult);
    if (saved.dbError) dbProblem = true;
    for (const l of targets) {
      if (results.has(l.id)) continue;
      const e = saved.entries.get(geminiKey(l));
      if (e && Date.parse(e.expiresAt) > Date.now()) results.set(l.id, e.value);
    }
    reused = results.size;
    const missing = targets.filter((l) => !results.has(l.id));
    if (!missing.length) return;
    if (!geminiConfigured()) {
      aiAvailable = false;
      return;
    }
    sent = missing.length;
    const run = await deps.generate(missing, totalDeadline);
    if (run.failed) aiAvailable = false;
    else if (run.partial) warnings.push(`AI summaries are missing for ${missing.length - run.results.size} launches; they will be retried on the next click.`);
    for (const [id, r] of run.results) results.set(id, r);
    await writeMany(
      [...run.results.entries()].map(([id, r]) => ({ key: geminiKey(missing.find((m) => m.id === id)!), value: r, ttlMs: TTL_GEMINI_MS })),
    );
  };
  const [, seen] = await Promise.all([aiPhase(), source === "LIVE" ? recordFirstSeen(launches.map((l) => l.id)) : Promise.resolve(null)]);
  if (!aiAvailable) warnings.unshift("AI summaries unavailable. The ranked list is unchanged: ranking never depends on Gemini.");
  if (dbProblem) warnings.push("The saved-copy database was unavailable for part of this run, so live data was used.");

  // ---- 5. Build rows ----
  const seenAt = (id: string) => seen?.get(id) ?? null;
  const rowOf = (l: Launch, withAi: boolean) =>
    buildRow(l, mc(l), asOf, hiddenSet.has(l.id), hiddenSet.has(l.id) ? null : scoreById.get(l.id)!, results.get(l.id), withAi, seenAt(l.id), staleCounts.has(l.id), scanned);
  const topSet = new Set(targets.map((l) => l.id));
  const ranked = topRanked.map((l) => rowOf(l, true));
  const moreLaunches = moreRanked.map((l) => rowOf(l, false));
  const tooEarlyRows = tooEarly.map((l) => rowOf(l, topSet.has(l.id)));

  return {
    source,
    fetchedAt,
    generatedAt: new Date().toISOString(),
    window: { from: new Date(asOf.getTime() - WINDOW_DAYS * 86_400_000).toISOString(), to: asOf.toISOString() },
    ranked,
    tooEarly: tooEarlyRows,
    moreLaunches,
    warnings,
    counted: { n: visible.filter((l) => counts.has(l.id)).length, of: visible.length, stale: visible.filter((l) => staleCounts.has(l.id)).length },
    ai: { available: aiAvailable, sentToGemini: sent, reusedSaved: reused, model: geminiModel() },
    refresh: { allowedNow: nextAvailableAt === null || Date.parse(nextAvailableAt) <= Date.now(), nextAvailableAt, applied: refreshApplied },
    extras: extras.filter((id) => scanned.some((c) => c.id === id)),
    newTagging: seen !== null,
    tookMs: Date.now() - t0,
  };
}

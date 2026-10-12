import { categoriesForSlugs, type Category } from "./categories";
import {
  URGENCY_HOT_MAX_DAYS,
  URGENCY_WEEK_MAX_DAYS,
  VOTES_HIDDEN_HOURS,
  WEIGHT_MAKER_COMMENTS,
  WEIGHT_VOTES,
} from "./config";
import type { Launch, ScoreParts, Urgency } from "./types";

// Pure functions. Rank = score from upvotes and maker comments only.

export function votesHidden(l: Pick<Launch, "votesCount" | "createdAt">, asOf: Date): boolean {
  const ageHours = (asOf.getTime() - Date.parse(l.createdAt)) / 3_600_000;
  return l.votesCount === 0 && ageHours < VOTES_HIDDEN_HOURS;
}

export function daysSinceLaunch(createdAt: string, asOf: Date): number {
  return Math.max(0, Math.floor((asOf.getTime() - Date.parse(createdAt)) / 86_400_000));
}

export function urgencyFor(days: number): Urgency {
  if (days <= URGENCY_HOT_MAX_DAYS) return "hot";
  if (days <= URGENCY_WEEK_MAX_DAYS) return "week";
  return "closing";
}

type Potential = Pick<Launch, "id" | "votesCount" | "commentsCount" | "name">;

/**
 * Cheap stand-in for the real score, used BEFORE maker comments are counted: the same 50/50 blend of upvotes and
 * comments, each as a share of the best in the reference set. Total comments (free in the list query) are an upper
 * bound for maker comments, because every maker comment is a comment. It only decides which launches to keep and
 * which to count first; the real score and rank are still computed from upvotes and maker comments alone.
 */
export function potentialOf(l: Potential, maxVotes: number, maxComments: number): number {
  const v = maxVotes > 0 ? l.votesCount / maxVotes : 0;
  const c = maxComments > 0 ? l.commentsCount / maxComments : 0;
  return 0.5 * v + 0.5 * c;
}

/** Highest potential first, then more upvotes, then name/id (stable and deterministic). */
export function potentialOrder<T extends Potential>(list: T[], reference: Potential[] = list): T[] {
  const maxVotes = Math.max(0, ...reference.map((l) => l.votesCount));
  const maxComments = Math.max(0, ...reference.map((l) => l.commentsCount));
  return [...list].sort(
    (a, b) =>
      potentialOf(b, maxVotes, maxComments) - potentialOf(a, maxVotes, maxComments) ||
      b.votesCount - a.votesCount ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Order in which maker comments are counted: highest potential first (see potentialOf). */
export const countingOrder = potentialOrder;

/**
 * Which launches to count in THIS run: those without a valid saved count, highest potential first,
 * at most `cap` of them. Launches that already have a valid count are never selected, so counts
 * accumulate from run to run instead of being capped by position in the list.
 */
export function selectToCount<T extends Potential>(launches: T[], hasValidCount: ReadonlySet<string>, cap: number): T[] {
  return potentialOrder(launches.filter((l) => !hasValidCount.has(l.id)), launches).slice(0, Math.max(0, cap));
}

export interface ScoreInput {
  id: string;
  name: string;
  createdAt: string;
  votesCount: number;
  makerComments: number | null; // null = not counted
}

export interface ScoreOutput {
  id: string;
  exact: number;
  score: number; // one decimal, for display
  provisional: boolean;
  parts: ScoreParts;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Score = 100 x (0.5 x V + 0.5 x M); V and M are shares of the current best. Nothing else enters. */
export function scoreAll(items: ScoreInput[]): ScoreOutput[] {
  const maxVotes = items.reduce((m, i) => Math.max(m, i.votesCount), 0);
  const maxMaker = items.reduce((m, i) => Math.max(m, i.makerComments ?? 0), 0);
  return items.map((i) => {
    const V = maxVotes > 0 ? i.votesCount / maxVotes : 0;
    const M = maxMaker > 0 && i.makerComments !== null ? i.makerComments / maxMaker : 0;
    const exact = 100 * (WEIGHT_VOTES * V + WEIGHT_MAKER_COMMENTS * M);
    const score = round1(exact);
    // Show parts that add up to the displayed score.
    const votesPoints = round1(100 * WEIGHT_VOTES * V);
    const makerPoints = round1(score - votesPoints);
    return {
      id: i.id,
      exact,
      score,
      provisional: i.makerComments === null,
      parts: {
        votes: i.votesCount,
        maxVotes,
        votesShare: V,
        makerComments: i.makerComments,
        maxMakerComments: maxMaker,
        makerShare: M,
        votesPoints,
        makerPoints,
      },
    };
  });
}

/** Score desc, then newer launch first, then product name. */
export function sortByScore<T extends { exact: number; createdAt: string; name: string }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => b.exact - a.exact || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.name.localeCompare(b.name),
  );
}

/** Hidden-vote group: maker comments (not counted last), then total comments. */
export function sortTooEarly<T extends { makerComments: number | null; commentsCount: number; name: string }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => (b.makerComments ?? -1) - (a.makerComments ?? -1) || b.commentsCount - a.commentsCount || a.name.localeCompare(b.name),
  );
}

// ---- code-derived tags ----
export function categoriesOf(l: Pick<Launch, "topics" | "viaSlugs">, scanned?: Category[]) {
  return categoriesForSlugs([...l.topics.map((t) => t.slug), ...l.viaSlugs], scanned);
}

export function founderInfo(l: Pick<Launch, "makers" | "hunter">) {
  const visible = l.makers.filter((m) => m.name?.trim() && !/redacted/i.test(m.name)).map((m) => ({ ...m, name: m.name.trim() }));
  const hiddenCount = l.makers.length - visible.length;
  const names = visible.map((m) => m.name);
  const hunter = names.length === 0 && l.hunter && !/redacted/i.test(l.hunter.name) ? l.hunter.name : null;
  // A public Product Hunt profile link, only when the username is visible and looks like a normal handle. Never an email.
  const people = visible.map((m) => ({ name: m.name, url: profileUrl(m.username) }));
  return { names, hiddenCount, hunter, people };
}

export function profileUrl(username: string | null | undefined): string | null {
  if (!username || /redacted/i.test(username) || !/^[A-Za-z0-9_.-]{1,60}$/.test(username)) return null;
  return `https://www.producthunt.com/@${username}`;
}

/** Only an https link is shown, so a bad value can never become a javascript: or data: link. */
export function safeSiteUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

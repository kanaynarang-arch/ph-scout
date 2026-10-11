import { categoriesForSlugs } from "./categories";
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

export const URGENCY_LABEL: Record<Urgency, string> = {
  hot: "Hot — contact now",
  week: "Contact this week",
  closing: "Window closing",
};

/** Cheap preliminary rank used only to decide whom to count maker comments for first. */
export function preliminaryOrder<T extends Pick<Launch, "votesCount" | "commentsCount" | "createdAt" | "name">>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      b.votesCount + b.commentsCount - (a.votesCount + a.commentsCount) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.name.localeCompare(b.name),
  );
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
export function categoriesOf(l: Pick<Launch, "topics" | "viaSlugs">) {
  return categoriesForSlugs([...l.topics.map((t) => t.slug), ...l.viaSlugs]);
}

export function founderInfo(l: Pick<Launch, "makers" | "hunter">) {
  const visible = l.makers.filter((m) => m.name && !/redacted/i.test(m.name));
  const hiddenCount = l.makers.length - visible.length;
  const names = visible.map((m) => m.name);
  const hunter = names.length === 0 && l.hunter && !/redacted/i.test(l.hunter.name) ? l.hunter.name : null;
  return { names, hiddenCount, hunter };
}

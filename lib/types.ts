import type { CategoryId } from "./categories";

export interface Maker {
  id: string;
  name: string;
  username: string;
}

export interface Launch {
  id: string;
  name: string;
  tagline: string;
  description: string;
  slug: string;
  url: string;
  votesCount: number;
  commentsCount: number;
  createdAt: string;
  featuredAt: string | null;
  topics: { slug: string; name: string }[];
  viaSlugs: string[]; // topic slugs this launch was found under
  makers: Maker[];
  hunter: { name: string; username: string } | null;
}

export type Fit = "strong" | "possible" | "weak" | "competitor";

export interface GeminiResult {
  oneLiner: string;
  fit: Fit;
  fitReason: string;
  angle: string;
  evidenceQuote: string;
  verified: boolean;
}

export type Urgency = "hot" | "week" | "closing";

export interface ScoreParts {
  votes: number;
  maxVotes: number;
  votesShare: number; // V
  makerComments: number | null;
  maxMakerComments: number;
  makerShare: number; // M
  votesPoints: number; // display, one decimal
  makerPoints: number; // display, one decimal
}

export interface ScoredLaunch {
  id: string;
  name: string;
  tagline: string;
  description: string;
  url: string;
  votesCount: number;
  commentsCount: number;
  createdAt: string;
  makerComments: number | null; // null = not counted
  makerCommentsStale: boolean; // count comes from a saved copy older than its 6-hour life (shown as CACHED)
  votesHidden: boolean;
  daysSinceLaunch: number;
  urgency: Urgency;
  categories: CategoryId[];
  founders: { names: string[]; hiddenCount: number; hunter: string | null };
  score: number; // display, one decimal
  provisional: boolean;
  parts: ScoreParts;
  ai: {
    available: boolean;
    oneLiner: string;
    fit: Fit | "unrated";
    fitReason: string;
    angle: string;
    evidenceQuote: string | null;
    quoteStatus: "verified" | "unverified" | "none";
  };
  firstSeenAt: string | null;
}

export type Source = "LIVE" | "CACHED" | "SAMPLE";

export type NotificationStatus = "sending" | "cooldown" | "daily_cap" | "off" | "skipped_sample" | "skipped";

/** Result of the "send a copy to Kavya" decision for this request. Never contains secrets or addresses. */
export interface Notification {
  status: NotificationStatus;
  retryInSeconds?: number;
  channels?: ("telegram" | "email")[]; // which channels are configured (names only)
}

export interface ScoutResponse {
  source: Source;
  fetchedAt: string;
  generatedAt: string;
  window: { from: string; to: string };
  ranked: ScoredLaunch[];
  tooEarly: ScoredLaunch[];
  moreLaunches: ScoredLaunch[];
  warnings: string[];
  counted: { n: number; of: number; stale: number };
  ai: { available: boolean; sentToGemini: number; reusedSaved: number; model: string };
  refresh: { allowedNow: boolean; nextAvailableAt: string | null; applied: boolean };
  newTagging: boolean; // true when firstSeenAt values are usable
  tookMs: number;
  notification?: Notification;
}

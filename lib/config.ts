// All tunable constants live here.
export const WINDOW_DAYS = 7;
export const PER_CATEGORY_TOP = 25; // launches kept per category, chosen by upvotes AND total comments (see potentialOrder)
export const PAGE_SIZE = 20;
export const MAX_PAGES_PER_TOPIC = 4; // pool depth: 80 launches per topic by votes; each page costs about 100 API points

export const MAKER_COMMENT_K = 40; // most launches to fetch maker comments for in ONE run (saved counts accumulate across runs)
export const MAKER_COMMENT_MAX_PAGES = 4; // pages of comments per post
export const MAKER_COMMENT_CONCURRENCY = 5;
export const RATE_LIMIT_RESERVE = 1500; // stop counting when remaining points fall to this
export const POINTS_PER_COMMENT_PAGE = 100; // measured estimate

export const VOTES_HIDDEN_HOURS = 6;

// Equal weights: the case names both signals but gives no weights (our assumption).
export const WEIGHT_VOTES = 0.5;
export const WEIGHT_MAKER_COMMENTS = 0.5;

export const GEMINI_TOP_N = 60;
export const GEMINI_HIDDEN_EXTRA = 3;
export const GEMINI_BATCH_SIZE = 15;
export const GEMINI_TEMPERATURE = 0.2;
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
export const PROMPT_VERSION = "p3";
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.8-flash"; // the same Gemini Flash model, reached through the OpenRouter gateway (backup route only)

export const URGENCY_HOT_MAX_DAYS = 2; // 0-2 hot
export const URGENCY_WEEK_MAX_DAYS = 4; // 3-4 this week, 5-7 closing (2 or fewer days left of the 7-day window)

export const TTL_LIST_MS = 60 * 60 * 1000; // 1 hour
export const TTL_COUNTS_MS = 6 * 60 * 60 * 1000; // 6 hours
export const TTL_GEMINI_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const REFRESH_NOW_COOLDOWN_MS = 5 * 60 * 1000;
export const LOCK_TTL_MS = 60 * 1000;
export const PURGE_GRACE_MS = 24 * 60 * 60 * 1000; // delete rows expired more than this ago
export const PURGE_LIMIT = 500;

export const DB_TIMEOUT_MS = 2500;
export const COUNT_PHASE_DEADLINE_MS = 24_000; // stop counting maker comments after this
export const TOTAL_DEADLINE_MS = 52_000; // return what is ready after this

export const CACHE_NS = process.env.CACHE_NS || "v1"; // override only for isolated tests

// ---- auto-send of a copy of the list to Kavya (Telegram + email), on Generate only ----
export const APP_PUBLIC_URL = "https://ph-scout.vercel.app";
export const NOTIFY_COOLDOWN_SECONDS = 5 * 60; // at least 5 minutes between claimed sends
export const NOTIFY_TOP_N = 10;
export const NOTIFY_TIMEOUT_MS = 8000;
export const TELEGRAM_PART_LIMIT = 3900; // Telegram allows 4096; stay well under 4000

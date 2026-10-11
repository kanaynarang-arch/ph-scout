// All tunable constants live here.
export const WINDOW_DAYS = 7;
export const PER_CATEGORY_TOP = 20; // top launches by votes per category
export const PAGE_SIZE = 20;
export const MAX_PAGES_PER_TOPIC = 2;

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

export const URGENCY_HOT_MAX_DAYS = 2; // 0-2 hot
export const URGENCY_WEEK_MAX_DAYS = 5; // 3-5 this week, 6-7 closing

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

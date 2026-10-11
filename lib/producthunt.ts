import { potentialOrder } from "./score";
import { CATEGORIES, categoriesForSlugs, type Category } from "./categories";
import {
  MAKER_COMMENT_CONCURRENCY,
  MAKER_COMMENT_MAX_PAGES,
  MAX_PAGES_PER_TOPIC,
  PAGE_SIZE,
  PER_CATEGORY_TOP,
  POINTS_PER_COMMENT_PAGE,
  RATE_LIMIT_RESERVE,
  WINDOW_DAYS,
} from "./config";
import type { Launch } from "./types";

const URL = "https://api.producthunt.com/v2/api/graphql";

/** The launch link, without the tracking query. Anything that is not a Product Hunt https link falls back to the site home, so a bad value can never become a javascript: or other link. */
export function safeLaunchUrl(u: unknown): string {
  const clean = String(u ?? "").split("?")[0];
  return /^https:\/\/www\.producthunt\.com\/[^\s<>"']*$/.test(clean) ? clean : "https://www.producthunt.com/";
}

export class PhError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "rate" | "http" | "schema" | "network" | "missing-token",
  ) {
    super(message);
  }
}

export interface RateState {
  remaining: number | null;
}

async function gql<T>(queryText: string, variables: Record<string, unknown>, rate: RateState, signal?: AbortSignal): Promise<T> {
  const token = process.env.PH_API_TOKEN;
  if (!token) throw new PhError("PH_API_TOKEN is not set", "missing-token");
  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: queryText, variables }),
      signal: signal ?? AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new PhError("Could not reach Product Hunt", "network");
  }
  const rem = res.headers.get("x-rate-limit-remaining");
  if (rem !== null && !Number.isNaN(Number(rem))) rate.remaining = Number(rem);
  if (res.status === 401 || res.status === 403) throw new PhError("Product Hunt rejected the token", "auth");
  if (res.status === 429) throw new PhError("Product Hunt rate limit reached", "rate");
  let body: { data?: T; errors?: { message?: string }[] };
  try {
    body = await res.json();
  } catch {
    throw new PhError(`Product Hunt returned HTTP ${res.status}`, "http");
  }
  if (body.errors?.length) {
    const msg = body.errors[0]?.message ?? "GraphQL error";
    if (/rate limit/i.test(msg)) throw new PhError("Product Hunt rate limit reached", "rate");
    if (/unauthor|invalid_oauth|token/i.test(msg)) throw new PhError("Product Hunt rejected the token", "auth");
    throw new PhError(`Product Hunt query error: ${msg.slice(0, 100)}`, "schema");
  }
  if (!res.ok || !body.data) throw new PhError(`Product Hunt returned HTTP ${res.status}`, "http");
  return body.data;
}

const LIST_QUERY = `
query($after: String, $since: DateTime!, $topic: String) {
  posts(first: ${PAGE_SIZE}, after: $after, topic: $topic, postedAfter: $since, order: VOTES) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name tagline description slug url website votesCount commentsCount
      createdAt featuredAt
      user { name username }
      topics(first: 5) { nodes { slug name } }
      makers { id name username }
    }
  }
}`;

interface RawPost {
  id: string;
  name: string;
  tagline: string;
  description: string | null;
  slug: string;
  url: string;
  website?: string | null;
  votesCount: number;
  commentsCount: number;
  createdAt: string;
  featuredAt: string | null;
  user: { name: string; username: string } | null;
  topics: { nodes: { slug: string; name: string }[] };
  makers: { id: string; name: string; username: string }[];
}

interface PostsData {
  posts: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawPost[] };
}

function toLaunch(p: RawPost, slug: string): Launch {
  return {
    id: String(p.id),
    name: p.name,
    tagline: p.tagline ?? "",
    description: p.description ?? "",
    slug: p.slug,
    // Keep the launch link but drop the tracking query string.
    url: safeLaunchUrl(p.url),
    votesCount: p.votesCount ?? 0,
    commentsCount: p.commentsCount ?? 0,
    createdAt: p.createdAt,
    featuredAt: p.featuredAt ?? null,
    website: p.website ?? null,
    topics: p.topics?.nodes ?? [],
    viaSlugs: [slug],
    makers: (p.makers ?? []).map((m) => ({ id: String(m.id), name: m.name, username: m.username })),
    hunter: p.user ? { name: p.user.name, username: p.user.username } : null,
  };
}

/**
 * Launches (featured or not) from the last WINDOW_DAYS days. Each topic is read by votes, MAX_PAGES_PER_TOPIC pages deep,
 * de-duplicated by post id. Per category the PER_CATEGORY_TOP launches with the most potential are kept: a 50/50 blend of
 * upvotes and total comments (potentialOf), so a launch with fewer votes but a very active comment thread is not
 * cut just because it sits lower by votes alone.
 */
export async function fetchLaunches(now: Date, rate: RateState, categories: Category[] = CATEGORIES): Promise<Launch[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const byId = new Map<string, Launch>();
  const perCategory = new Map<string, Set<string>>();

  await Promise.all(
    categories.map(async (cat) => {
      const ids = new Set<string>();
      perCategory.set(cat.id, ids);
      await Promise.all(
        cat.slugs.map(async (slug) => {
          let after: string | null = null;
          for (let page = 0; page < MAX_PAGES_PER_TOPIC; page++) {
            const data: PostsData = await gql<PostsData>(LIST_QUERY, { after, since, topic: slug }, rate);
            for (const raw of data.posts.nodes) {
              const l = toLaunch(raw, slug);
              const existing = byId.get(l.id);
              if (existing) {
                if (!existing.viaSlugs.includes(slug)) existing.viaSlugs.push(slug);
              } else byId.set(l.id, l);
              ids.add(l.id);
            }
            if (!data.posts.pageInfo.hasNextPage) break;
            after = data.posts.pageInfo.endCursor;
          }
        }),
      );
    }),
  );

  // Keep the PER_CATEGORY_TOP launches with the most potential in each category (same reference maxima for all).
  const pool = [...byId.values()];
  const keep = new Set<string>();
  for (const ids of perCategory.values()) {
    potentialOrder([...ids].map((id) => byId.get(id)!), pool)
      .slice(0, PER_CATEGORY_TOP)
      .forEach((l) => keep.add(l.id));
  }
  const windowStart = Date.parse(since);
  return [...keep]
    .map((id) => byId.get(id)!)
    .filter((l) => Date.parse(l.createdAt) >= windowStart)
    .map((l) => ({ ...l, topics: l.topics }));
}

const COMMENTS_QUERY = `
query($id: ID!, $after: String) {
  post(id: $id) {
    comments(first: 20, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id userId replies(first: 20) { nodes { id userId } } }
    }
  }
}`;

interface CommentsData {
  post: {
    comments: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { id: string; userId: string; replies: { nodes: { id: string; userId: string }[] } }[];
    };
  } | null;
}

/** Count comments and replies whose userId is one of the launch's maker ids (at most 4 pages). */
export async function countMakerComments(launch: Launch, rate: RateState): Promise<number> {
  const makerIds = new Set(launch.makers.map((m) => m.id));
  if (makerIds.size === 0 || launch.commentsCount === 0) return 0;
  let after: string | null = null;
  let count = 0;
  for (let page = 0; page < MAKER_COMMENT_MAX_PAGES; page++) {
    const data: CommentsData = await gql<CommentsData>(COMMENTS_QUERY, { id: launch.id, after }, rate);
    const comments = data.post?.comments;
    if (!comments) break;
    for (const c of comments.nodes) {
      if (makerIds.has(String(c.userId))) count++;
      for (const r of c.replies?.nodes ?? []) if (makerIds.has(String(r.userId))) count++;
    }
    if (!comments.pageInfo.hasNextPage) break;
    after = comments.pageInfo.endCursor;
  }
  return count;
}

export interface CountOutcome {
  counts: Map<string, number>; // launch id -> maker comments, only those counted now
  stopped: "done" | "reserve" | "rate-limit" | "deadline" | "error" | "k";
}

/**
 * Count maker comments for `ordered` launches (already in preliminary rank order) until the
 * rate-limit reserve, the deadline, or the limit `slots` is reached. Does not throw.
 */
export async function countMakerCommentsBatch(
  ordered: Launch[],
  slots: number,
  rate: RateState,
  deadlineAt: number,
): Promise<CountOutcome> {
  const counts = new Map<string, number>();
  let stopped: CountOutcome["stopped"] = ordered.length > slots ? "k" : "done";
  let next = 0;
  let inflight = 0;
  const queue = ordered.slice(0, slots);

  async function one(): Promise<boolean> {
    if (next >= queue.length) return false;
    if (Date.now() > deadlineAt) {
      stopped = "deadline";
      return false;
    }
    // Budget left after this request and the ones already in flight must still be above the reserve.
    const projected = (rate.remaining ?? Infinity) - (inflight + 1) * POINTS_PER_COMMENT_PAGE;
    if (projected <= RATE_LIMIT_RESERVE) {
      stopped = "reserve";
      return false;
    }
    const launch = queue[next++];
    inflight++;
    try {
      counts.set(launch.id, await countMakerComments(launch, rate));
    } catch (e) {
      stopped = e instanceof PhError && e.kind === "rate" ? "rate-limit" : "error";
      next = queue.length; // stop everyone
      return false;
    } finally {
      inflight--;
    }
    return true;
  }

  async function worker() {
    while (await one());
  }

  // If the remaining budget is unknown, count one launch first to learn it. This stops five parallel
  // requests from starting when the budget is already at the reserve.
  if (rate.remaining === null && !(await one())) return { counts, stopped };
  await Promise.all(Array.from({ length: MAKER_COMMENT_CONCURRENCY }, worker));
  return { counts, stopped };
}

export { categoriesForSlugs };

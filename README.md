# ProductHunt Partnership Scout

A ranked outreach list for Kavya, who leads partnerships at a B2B SaaS company that helps remote teams run async standups. One click scans Product Hunt launches from the **last 7 days** in four categories (project management, HR tech, developer productivity, team communication) and returns the launches in score order with the six fields the case asks for: product name, founder name, one-line description, upvote count, days since launch and a suggested outreach angle that explains how Kavya's product could complement theirs.

**Nothing is ever sent.** The tool never sends a message, never looks up or scrapes an email address and never contacts a founder. Kavya reads the list and does all outreach herself (the human review gate on the Components Map).

![Components Map](docs/components-map.png)

Components Map: [docs/components-map.png](docs/components-map.png)

## How it works

1. **Generate** (Kavya) calls `POST /api/scout`. The four categories are built in (`lib/categories.ts`).
2. The server fetches launches (featured or not) from the last 7 days through the Product Hunt GraphQL API v2: the top 20 by votes per category, up to 2 pages per topic, de-duplicated by post id.
3. It counts **maker comments** (top-level comments and replies written by one of the launch's makers, matched by user id) down the ranked list, up to 40 launches, stopping early when the Product Hunt rate-limit budget falls to a reserve.
4. **Score and rank are computed in code.** Gemini never touches the order.
5. **Gemini Flash** (`@google/genai`) labels partnership fit and writes a one-liner, an outreach angle and a verbatim evidence quote, in batched calls. Only launches without a saved result are sent. Only launch text is sent (name, tagline, description, topic names): no maker or commenter names or ids.
6. Code **verifies every quote** against the launch tagline and description. A quote that fails twice is shown with an "Unverified" tag, never hidden.
7. The list is shown in score order with tags (fit, category, urgency), a category filter and a "Strong and possible fit only" switch (both only hide rows), and a source badge: **LIVE**, **CACHED** or **SAMPLE**.

If Product Hunt fails the app serves the saved copy from Neon labelled **CACHED** (with its original fetch time), and if there is none, the bundled snapshot labelled **SAMPLE**. If Gemini fails, every row keeps its rank and shows neutral text with an "AI summaries unavailable" banner.

## Ranking formula

```
V = votes / maxVotes
M = makerComments / maxMakerComments
Score = 100 x (0.5 x V + 0.5 x M)
```

`maxVotes` and `maxMakerComments` are the best values among the current launches. **Assumption: the case names upvotes and maker comments but gives no weights, so they count equally (0.5 each).** This is one constant in `lib/config.ts`. Nothing else enters the score. Fit, urgency, category and tags are labels and never change the order. Ties: newer launch first, then product name. Every row has a "How this was scored" note whose numbers add up to its score.

**Maker-comment limit.** Counting maker replies costs Product Hunt API points (about 100 per page of comments; the limit is 6,250 points per 15 minutes), so maker comments are counted for at most about 40 launches per run. A launch that was not reached shows "not counted" (not 0) and its score is tagged **Provisional**: it treats maker comments as 0, so the true score can only be higher. Counts are saved for 6 hours, so later runs fill in more launches. The page shows "counted for N of M launches". A team with many maker replies but few votes can therefore rank lower than a full count would put it.

Launches posted today often show 0 votes because Product Hunt hides them; those go to **Too early to rank** instead of the bottom of the list.

## Saved copies (Neon Postgres)

Neon Postgres (free plan, added through the Vercel Marketplace) stores **only public Product Hunt launch data, maker-comment counts, Gemini outputs and the first time each launch id was seen** (table `cache_entries`: launch list 1 hour, maker-comment counts 6 hours, Gemini results 7 days; table `launch_seen` powers the display-only "New since your last visit" tag). No secrets, no emails, no personal data. `db/schema.sql` is idempotent. If `DATABASE_URL` is missing or Neon is down, the app still works from memory and then the bundled snapshot. An in-memory layer sits in front of Neon (per server instance).

- **Refresh now** refetches the launch list at most once every 5 minutes (limit kept in Neon, so it holds across server instances) and reuses still-valid counts and Gemini results.
- `/api/refresh` (needs `Authorization: Bearer <CRON_SECRET>`, otherwise 401) runs the same pipeline with the same API budget to warm the saved copies and deletes long-expired rows. A GitHub Actions workflow calls it every 15 minutes and `vercel.json` has one daily cron (Hobby allows once a day). Generate works without either.

## Environment variables (names only)

| Name | Purpose |
|---|---|
| `PH_API_TOKEN` | Product Hunt developer token (server-side only) |
| `GEMINI_API_KEY` | Google AI Studio key (server-side only) |
| `GEMINI_MODEL` | Gemini Flash model id (default `gemini-3.8-flash`) |
| `DATABASE_URL` | Neon pooled connection string (added by the Vercel Neon integration) |
| `CRON_SECRET` | Protects `/api/refresh` |

Secrets live only in `.env.local` (git-ignored), Vercel env vars and GitHub Actions secrets. See `.env.example`.

## Run it

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run db:apply             # creates the tables in Neon (optional)
npm run dev
npm test
```

Kavya's company profile (what Gemini may say about her product) is in `config/profile.ts`.

## Notes

- Live data comes from the Product Hunt API, which is meant for **non-commercial** use by default. This is an exam demo and is not presented as a commercial product.
- Gemini Flash is the only AI used. No other AI provider is part of the app.
- Days since launch is whole days only (Product Hunt's launch time is day-level).

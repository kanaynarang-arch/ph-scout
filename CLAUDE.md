# Rules for working on ph-scout

- Gemini Flash only (through @google/genai). No Claude or other AI provider: no package, env var, import or API call.
- Secrets live only in env vars (PH_API_TOKEN, GEMINI_API_KEY, GEMINI_MODEL, DATABASE_URL, CRON_SECRET) and are never committed.
- The app never sends outreach, never looks up emails, never contacts founders. A human (Kavya) does all outreach.
- All numbers are computed in code. Gemini writes language only (fit label, one-liner, outreach angle, quote). Rank = score from upvotes and maker comments only.
- Only public launch text goes to Gemini. No maker or commenter names or IDs.
- Neon stores only public Product Hunt launch data, maker-comment counts, Gemini outputs and first-seen launch ids.
- The app must work with no DATABASE_URL and with Neon down (memory, then bundled snapshot labelled SAMPLE).

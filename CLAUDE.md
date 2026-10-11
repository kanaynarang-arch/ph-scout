# Rules for working on ph-scout

- Gemini Flash only (through @google/genai). No Claude or other AI provider: no package, env var, import or API call.
- Secrets live only in env vars (PH_API_TOKEN, GEMINI_API_KEY, GEMINI_MODEL, DATABASE_URL, CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RESEND_API_KEY, NOTIFY_EMAIL, NOTIFICATIONS_ENABLED) and are never committed.
- The tool never contacts founders, never looks up emails and never sends outreach. When Kavya clicks Generate it also sends a copy of the list to her own Telegram and email. A human (Kavya) does all outreach. The Draft message button asks Gemini Flash for a first message that Kavya edits and sends herself: that call gets only public launch text and the saved angle (never maker names; the page fills in the founder's first name from what is already on screen), returns text only, and nothing is ever sent.
- The copy to Kavya is sent ONLY by a real Generate click (never Refresh now, /api/refresh, page load or the GitHub Action), only to the recipients in server env vars, never to anyone else, and is limited to one per 5 minutes. Switch it off by unsetting NOTIFICATIONS_ENABLED.
- All numbers are computed in code. Gemini writes language only (fit label, one-liner, outreach angle, quote). Rank = score from upvotes and maker comments only.
- Only public launch text goes to Gemini. No maker or commenter names or IDs.
- Neon stores only public Product Hunt launch data, maker-comment counts, Gemini outputs, first-seen launch ids, and the send limits (one control row; never message text, tokens or addresses).
- The app must work with no DATABASE_URL and with Neon down (it then fetches live every time, and falls back to the bundled snapshot labelled SAMPLE).

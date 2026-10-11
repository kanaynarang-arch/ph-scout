# Submission: PS4 ProductHunt Partnership Scout

- **Public URL:** https://ph-scout.vercel.app
- **GitHub repo:** https://github.com/kanaynarang-arch/ph-scout
- **Components Map:** `docs/components-map.png` (includes the optional Draft message flow, steps D1 to D3) (also shown in the README; the earlier version is kept in the project folder as `PS4 Components Map (submitted v1).png`)

## 30-second demo path

1. Open the public URL and click **Generate**. The page turns into a dashboard: sidebar filters, four KPI tiles, the "Where the points come from" chart (hover for the numbers), top-score bars, a category donut and a "Start here" card for the rank 1 launch. The ranked list follows.
2. Point at the **source badge** (LIVE / CACHED / SAMPLE) with its fetch time (bottom of the sidebar), and the coverage card ("N of M launches counted").
3. Open a row: the six case fields, the **urgency badge**, the fit tag with its reason, and the **outreach angle with its quote** ("From the launch page", checked by code; "Unverified" if it could not be matched).
   Press **Draft message** to get an editable first message to the founder. The tool only writes it (Gemini Flash, no founder names; the page fills in the first name); Kavya edits it, copies it and sends it herself.
4. Expand a row, then **How this was scored** (upvotes + maker comments only) and try the category filters in the sidebar and the fit switch (they only hide rows).
5. Scroll to the footer: the tool **never contacts founders, never looks up emails and never sends outreach**. When Kavya clicks Generate it also sends a copy of the list to her own Telegram and email. Kavya does all outreach herself. (Generate also shows a quiet line: "Copy being sent to Kavya's Telegram and email", limited to one per 5 minutes.)

## The Nine Checks

| # | Check | Evidence from the case | Result |
|---|---|---|---|
| **Kill switches** (any No = do not build) | | | |
| 01 | Problem Real | 30 to 40 minutes every morning, documented in the brief, and launches are still missed. | Yes |
| 02 | Workflow Repeated | She checks every morning, and new launches appear daily, so the task recurs. | Yes |
| 03 | Input Available | The Product Hunt API (GraphQL v2) returns launches, upvotes, makers, topics and comments, verified live. | Yes |
| **Sizing** (any No = build something smaller) | | | |
| 04 | Output Valuable | A ranked list with a suggested angle is something Kavya acts on directly, in a window where timing decides whether outreach works. | Yes |
| 05 | Impact Measurable | Baseline 30 to 40 minutes a day. Target under 5. The list also shows the share of launches counted and its source and fetch time. | Yes |
| 08 | ROI Worth It | Free plans end to end (Vercel, Neon, Gemini Flash, Product Hunt API). One Generate click spends cached Product Hunt data and a few batched Gemini Flash calls. | Yes |
| **Boundary** (any No = build the tool, the human stays here) | | | |
| 06 | Failure Risk OK | The worst case is a weak ranking or angle that Kavya ignores. Every angle carries a quote checked in code against the launch text, and rows without a match are labelled Unverified. | Yes |
| 07 | Judgment Protected | For the list: yes, Kavya reviews it. For contacting founders: **No.** First contact is a relationship decision that cannot be taken back. | **No: THE CUT** |
| 09 | Owner Clear | Kavya owns every decision and every message to a founder. | Yes |

## The Cut

**Check killed: 07, Judgment Protected.** The brief describes Kavya's job as reaching out to founders. A tool that did that itself (emailing founders, looking up their addresses, or sending messages automatically) would remove her judgment at the most consequential step, and a wrong or badly timed message cannot be unsent.

So the tool is built to stop at the ranked list with a suggested outreach angle and, on request, a draft message for Kavya to edit and send herself. It never contacts founders, never looks up emails and never sends outreach. Kavya reads the list and does all outreach herself.

The one thing the app sends is a copy of the list to Kavya's own Telegram and email when she clicks Generate (recipients come from server settings only, at most one per 5 minutes, never for SAMPLE data). It can be switched off by unsetting `NOTIFICATIONS_ENABLED`.

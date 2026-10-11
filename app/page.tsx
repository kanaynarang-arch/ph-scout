"use client";

import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, categoryLabel, type CategoryId } from "@/lib/categories";
import { toCsv, type CsvRow } from "@/lib/csv";
import type { ScoredLaunch, ScoutResponse } from "@/lib/types";

const LAST_VISIT_KEY = "ph-scout:lastVisit";
const URGENCY_TEXT = { hot: "Hot — contact now", week: "Contact this week", closing: "Window closing" } as const;
const FIT_TEXT = { strong: "Strong fit", possible: "Possible fit", weak: "Weak fit", competitor: "Likely competitor", unrated: "Not rated" } as const;

/** Copy text to the clipboard, with a fallback for browsers that block the async clipboard API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Founder({ r }: { r: ScoredLaunch }) {
  const { names, hiddenCount, hunter } = r.founders;
  if (names.length) return <>{names.join(", ")}{hiddenCount > 0 ? ` (+${hiddenCount} hidden)` : ""}</>;
  if (hunter) return <>{hunter} <span className="meta">(Posted by (hunter, may not be the founder))</span></>;
  return <>Not available — <a href={r.url} target="_blank" rel="noreferrer">see the launch page</a></>;
}

function HowScored({ r }: { r: ScoredLaunch }) {
  const p = r.parts;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <details>
      <summary>How this was scored</summary>
      <div className="how">
        <div>Upvotes: {p.votes} of the best {p.maxVotes} = {pct(p.votesShare)} × 50 = {p.votesPoints.toFixed(1)} points</div>
        {p.makerComments === null ? (
          <div>Maker comments: not counted (0 points, so this score is Provisional and can only go up)</div>
        ) : (
          <div>Maker comments: {p.makerComments}{r.makerCommentsStale ? " (saved copy older than 6 hours, CACHED)" : ""} of the best {p.maxMakerComments} = {pct(p.makerShare)} × 50 = {p.makerPoints.toFixed(1)} points</div>
        )}
        <div><b>Score = {p.votesPoints.toFixed(1)} + {p.makerPoints.toFixed(1)} = {r.score.toFixed(1)}</b>. Only upvotes and maker comments count; fit, urgency and category never change the order.</div>
      </div>
    </details>
  );
}

function Row({ r, rank, showNew, aiShown }: { r: ScoredLaunch; rank?: number; showNew: boolean; aiShown: boolean }) {
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const copy = async () => {
    const ok = await copyText(r.ai.angle);
    setCopied(ok ? "ok" : "fail");
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <article className={`row${aiShown && r.ai.fit === "competitor" ? " competitor" : ""}`}>
      <div className="row-head">
        <div>
          {rank !== undefined && <span className="rank">#{rank}</span>}
          <a className="name" href={r.url} target="_blank" rel="noreferrer">{r.name}</a>
          <div className="meta">Founder: <Founder r={r} /></div>
          <div style={{ marginTop: 4 }}>{r.ai.oneLiner}</div>
        </div>
        <div className="scorebox">
          {r.votesHidden ? <span className="badge">votes hidden</span> : (
            <>
              <div className="score">{r.score.toFixed(1)}</div>
              <div className="meta">score{r.provisional ? " · " : ""}{r.provisional && <span className="tag" style={{ margin: 0 }}>Provisional</span>}</div>
            </>
          )}
        </div>
      </div>
      <div className="facts">
        <div><b>Upvotes</b>{r.votesHidden ? "votes hidden" : r.votesCount}</div>
        <div><b>Maker comments</b>{r.makerComments === null ? "not counted" : r.makerComments}{r.makerCommentsStale && <span className="meta" title="Saved copy older than 6 hours; it will be refreshed on a later run"> · saved copy (CACHED)</span>}</div>
        <div><b>Days since launch</b>{r.daysSinceLaunch}</div>
      </div>
      <div>
        {showNew && <span className="tag t-new">New since your last visit</span>}
        <span className={`tag t-${r.urgency}`}>{URGENCY_TEXT[r.urgency]}</span>
        {aiShown && <span className={`tag t-${r.ai.fit}`}>{FIT_TEXT[r.ai.fit]}</span>}
        {r.categories.map((c) => <span key={c} className="tag">{categoryLabel(c)}</span>)}
        {r.votesHidden && <span className="tag">Votes hidden</span>}
      </div>
      {aiShown && r.ai.fitReason && <div className="meta">Fit: {r.ai.fitReason}</div>}
      {aiShown && (
        <div className="angle">
          <div className="label">Suggested outreach angle (a starting point for you, not a message)</div>
          <div>{r.ai.angle}</div>
          {r.ai.quoteStatus !== "none" && r.ai.evidenceQuote && (
            <div className="quote">
              {r.ai.quoteStatus === "verified" ? "From the launch page" : "Unverified"}: “{r.ai.evidenceQuote}”
            </div>
          )}
          <button style={{ marginTop: 8, padding: "4px 10px", fontSize: 13 }} onClick={copy}>{copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed: select the text" : "Copy angle"}</button>
        </div>
      )}
      {!r.votesHidden && <HowScored r={r} />}
    </article>
  );
}

export default function Page() {
  const [data, setData] = useState<ScoutResponse | null>(null);
  const [loading, setLoading] = useState<"generate" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<CategoryId | "all">("all");
  const [fitOnly, setFitOnly] = useState(false);
  const [prevVisit, setPrevVisit] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    try { setPrevVisit(localStorage.getItem(LAST_VISIT_KEY)); } catch { /* storage blocked */ }
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  async function run(refresh: boolean) {
    setLoading(refresh ? "refresh" : "generate");
    setError(null);
    try {
      const res = await fetch("/api/scout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      setData(json as ScoutResponse);
      if ((json as ScoutResponse).source === "LIVE") {
        try { localStorage.setItem(LAST_VISIT_KEY, (json as ScoutResponse).generatedAt); } catch { /* storage blocked */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(null);
    }
  }

  const refreshWaitMin = useMemo(() => {
    void tick;
    if (!data?.refresh.nextAvailableAt) return 0;
    const ms = Date.parse(data.refresh.nextAvailableAt) - Date.now();
    return ms > 0 ? Math.ceil(ms / 60_000) : 0;
  }, [data, tick]);

  const visible = (rows: ScoredLaunch[]) =>
    rows.filter((r) => (cat === "all" || r.categories.includes(cat)) && (!fitOnly || r.ai.fit === "strong" || r.ai.fit === "possible"));
  const isNew = (r: ScoredLaunch) =>
    Boolean(data && data.source === "LIVE" && data.newTagging && prevVisit && r.firstSeenAt && Date.parse(r.firstSeenAt) > Date.parse(prevVisit));

  const ranked = data ? visible(data.ranked) : [];
  const tooEarly = data ? visible(data.tooEarly) : [];
  const more = data ? visible(data.moreLaunches) : [];

  // Coverage of maker comments, straight from the data on the page.
  const provisionalRows = data ? [...data.ranked, ...data.moreLaunches].filter((r) => r.provisional).length : 0;

  // CSV: exactly the rows currently visible (chips and fit switch applied), in the order shown.
  // "More launches" rows are included only while that section is open.
  const csvRows = (): CsvRow[] => {
    if (!data) return [];
    const out: CsvRow[] = ranked.map((launch) => ({ rank: data.ranked.indexOf(launch) + 1, launch }));
    for (const launch of tooEarly) out.push({ rank: null, launch });
    if (moreOpen) for (const launch of more) out.push({ rank: data.ranked.length + data.moreLaunches.indexOf(launch) + 1, launch });
    return out;
  };
  const flash = (msg: string) => {
    setExportMsg(msg);
    setTimeout(() => setExportMsg(null), 3000);
  };
  const copyCsv = async () => {
    const rows = csvRows();
    const ok = await copyText(toCsv(rows));
    flash(ok ? `Copied ${rows.length} rows` : "Copy failed: use Download CSV instead");
  };
  const downloadCsv = () => {
    const rows = csvRows();
    const blob = new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ph-scout-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(`Downloaded ${rows.length} rows`);
  };
  const exportCount = data ? ranked.length + tooEarly.length + (moreOpen ? more.length : 0) : 0;

  return (
    <main>
      <h1>ProductHunt Partnership Scout</h1>
      <p className="sub">Launches from the last 7 days in project management, HR tech, developer productivity and team communication, ranked by upvotes and maker comments. Nothing is ever sent from this tool.</p>

      <div className="bar">
        <button className="primary" onClick={() => run(false)} disabled={loading !== null}>{loading === "generate" ? "Generating…" : "Generate"}</button>
        <button onClick={() => run(true)} disabled={loading !== null || !data || refreshWaitMin > 0} title="Fetch the launch list again (once every 5 minutes)">
          {loading === "refresh" ? "Refreshing…" : refreshWaitMin > 0 ? `Refresh now (in ${refreshWaitMin} min)` : "Refresh now"}
        </button>
        {data && (
          <span className="meta">
            <span className={`badge b-${data.source.toLowerCase()}`}>{data.source}</span>{" "}
            {data.source === "SAMPLE" ? "bundled sample data from " : "fetched "}{fmtTime(data.fetchedAt)} · counted for {data.counted.n} of {data.counted.of} launches
          </span>
        )}
      </div>

      {loading && <div className="banner" style={{ background: "var(--blue-bg)", color: "var(--accent)" }}>Scanning Product Hunt and writing outreach angles. The first run can take up to a minute.</div>}
      {error && <div className="banner err">{error}</div>}
      {data?.warnings.map((w, i) => <div key={i} className={`banner ${w.startsWith("AI summaries unavailable") || w.startsWith("Live Product Hunt") ? "err" : ""}`}>{w}</div>)}

      {data && (
        <>
          <div className="bar">
            <button className={`chip ${cat === "all" ? "on" : ""}`} onClick={() => setCat("all")}>All categories</button>
            {CATEGORIES.map((c) => (
              <button key={c.id} className={`chip ${cat === c.id ? "on" : ""}`} onClick={() => setCat(c.id)}>{c.label}</button>
            ))}
            <label className="switch">
              <input type="checkbox" checked={fitOnly} disabled={!data.ai.available} onChange={(e) => setFitOnly(e.target.checked)} />
              Strong and possible fit only
            </label>
          </div>

          <div className="coverage" role="status">
            Maker comments counted for <b>{data.counted.n} of {data.counted.of}</b> launches.{" "}
            {provisionalRows > 0
              ? <>{provisionalRows} {provisionalRows === 1 ? "row is" : "rows are"} <b>Provisional</b>: {provisionalRows === 1 ? "its" : "their"} score is a lower bound until counted.</>
              : <>No row is Provisional.</>}
            {data.counted.stale > 0 && <> {data.counted.stale} {data.counted.stale === 1 ? "count comes" : "counts come"} from a saved copy older than 6 hours (CACHED).</>}
          </div>

          <h2>Ranked outreach list ({ranked.length})</h2>
          <p className="meta" style={{ marginTop: 0 }}>In order of score. Filters only hide rows. Window: {fmtTime(data.window.from)} to {fmtTime(data.window.to)}.</p>
          <div className="bar" style={{ margin: "6px 0 2px" }}>
            <button onClick={copyCsv} disabled={exportCount === 0}>Copy as CSV</button>
            <button onClick={downloadCsv} disabled={exportCount === 0}>Download CSV</button>
            <span className="meta" role="status" aria-live="polite">{exportMsg ?? `Exports the ${exportCount} visible rows`}</span>
          </div>
          {ranked.length === 0 && <div className="empty">No launches match. Widen the filters{data.counted.of === 0 ? `, or no launches were found between ${fmtTime(data.window.from)} and ${fmtTime(data.window.to)}` : ""}.</div>}
          {ranked.map((r, i) => <Row key={r.id} r={r} rank={data.ranked.indexOf(r) + 1 || i + 1} showNew={isNew(r)} aiShown />)}

          {data.tooEarly.length > 0 && (
            <>
              <h2>Too early to rank ({tooEarly.length})</h2>
              <p className="meta" style={{ marginTop: 0 }}>Launched today; Product Hunt is still hiding the votes. They have no score yet and are not ranked.</p>
              {tooEarly.map((r) => <Row key={r.id} r={r} showNew={isNew(r)} aiShown={r.ai.angle !== ""} />)}
            </>
          )}

          {data.moreLaunches.length > 0 && (
            <details style={{ marginTop: 24 }} open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
              <summary>More launches ({more.length}), in score order, without an angle</summary>
              {more.map((r) => <Row key={r.id} r={r} rank={data.ranked.length + data.moreLaunches.indexOf(r) + 1} showNew={isNew(r)} aiShown={false} />)}
            </details>
          )}
        </>
      )}

      {!data && !loading && <div className="empty">Click Generate to build today&apos;s list.</div>}

      <div className="foot">
        Review gate: you read the list and do all outreach yourself. This tool never sends a message, never looks up an email and never contacts founders.
        Live data comes from the Product Hunt API (non-commercial use); AI text comes from Gemini Flash and never changes the order. Source badge: LIVE = fetched from Product Hunt now or within the last hour, CACHED = an older saved copy after a failed refresh, SAMPLE = bundled demo data.
      </div>
    </main>
  );
}

"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { CATEGORIES, categoryLabel, type CategoryId } from "@/lib/categories";
import { rowsLabel, toCsv, type CsvRow } from "@/lib/csv";
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

const IconUp = () => (<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>);
const IconChat = () => (<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>);
const IconDay = () => (<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg>);

/** The score counts up once when a card appears (skipped when the visitor prefers reduced motion). */
function Score({ value, animate }: { value: number; animate: boolean }) {
  const [shown, setShown] = useState(value);
  useLayoutEffect(() => {
    if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 400);
      setShown(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setShown(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  return <>{shown.toFixed(1)}</>;
}

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
    <details className="how-wrap">
      <summary>How this was scored</summary>
      <dl className="how">
        <dt>Upvotes</dt>
        <dd>{p.votes} of the best {p.maxVotes} = {pct(p.votesShare)} × 50 = {p.votesPoints.toFixed(1)} points</dd>
        <dt>Maker comments</dt>
        {p.makerComments === null ? (
          <dd>Not counted (0 points, so this score is Provisional and can only go up)</dd>
        ) : (
          <dd>{p.makerComments}{r.makerCommentsStale ? " (saved copy older than 6 hours, CACHED)" : ""} of the best {p.maxMakerComments} = {pct(p.makerShare)} × 50 = {p.makerPoints.toFixed(1)} points</dd>
        )}
        <dt>Score</dt>
        <dd><b>{p.votesPoints.toFixed(1)} + {p.makerPoints.toFixed(1)} = {r.score.toFixed(1)}</b></dd>
        <div className="full">Only upvotes and maker comments count; fit, urgency and category never change the order.</div>
      </dl>
    </details>
  );
}

function Row({ r, rank, showNew, aiShown, index, onCopied }: { r: ScoredLaunch; rank?: number; showNew: boolean; aiShown: boolean; index?: number; onCopied: (msg: string) => void }) {
  const copy = async () => {
    const ok = await copyText(r.ai.angle);
    onCopied(ok ? "Angle copied" : "Copy failed: select the text");
  };
  const competitor = aiShown && r.ai.fit === "competitor";
  const cls = ["card"];
  if (rank !== undefined && rank <= 3) cls.push("top");
  if (rank === 1) cls.push("top1");
  if (competitor) cls.push("competitor");
  if (index !== undefined && index < 10) cls.push("enter");
  return (
    <article className={cls.join(" ")} style={index !== undefined && index < 10 ? ({ "--i": index } as React.CSSProperties) : undefined}>
      <div className="rankcol">
        {rank !== undefined && (rank <= 3 ? <span className="pill p-medal">#{rank}</span> : <span className="rank">#{rank}</span>)}
      </div>
      <div className="top-block">
        <div className="titleline">
          <a className="name" href={r.url} target="_blank" rel="noreferrer">{r.name}</a>
          {showNew && <span className="pill p-new">New since your last visit</span>}
          {aiShown && <span className={`pill p-${r.ai.fit}`}>{FIT_TEXT[r.ai.fit]}</span>}
          {r.provisional && <span className="pill p-provisional">Provisional</span>}
          {r.votesHidden && <span className="pill">Votes hidden</span>}
        </div>
        <div className="founder">Founder: <Founder r={r} /></div>
        <p className="desc">{r.ai.oneLiner}</p>
        <div className="metarow">
          <span className="mi"><IconUp /><span className="lbl">Upvotes</span> <b>{r.votesHidden ? "votes hidden" : r.votesCount}</b></span>
          <span className="mi"><IconChat /><span className="lbl">Maker comments</span> <b>{r.makerComments === null ? "not counted" : r.makerComments}</b>{r.makerCommentsStale && <span className="stale" title="Saved copy older than 6 hours; it will be refreshed on a later run">saved copy (CACHED)</span>}</span>
          <span className="mi"><IconDay /><span className="lbl">Days since launch</span> <b>{r.daysSinceLaunch}</b></span>
          <span className={`urg urg-${r.urgency}`}><i aria-hidden="true" />{URGENCY_TEXT[r.urgency]}</span>
        </div>
        {aiShown && r.ai.fitReason && <div className="fitline">Fit: {r.ai.fitReason}</div>}
        {r.categories.length > 0 && <div className="fitline cats">{r.categories.map(categoryLabel).join(" · ")}</div>}
      </div>
      <div className="scorebox">
        {r.votesHidden ? <div className="hidden">votes hidden</div> : (
          <>
            <div><span className="score"><Score value={r.score} animate={index !== undefined && index < 10} /></span><span className="of">/100</span></div>
            <div className={`bar3${r.provisional ? " prov" : ""}`}><i style={{ width: `${Math.max(0, Math.min(100, r.score))}%` }} /></div>
          </>
        )}
      </div>
      {(aiShown || !r.votesHidden) && (
        <div className="body">
          {aiShown && (
            <div className="angle">
              <div className="row1">
                <div>
                  <div className="micro">Suggested outreach angle</div>
                  <div className="note">A starting point for you, not a message</div>
                </div>
                <button className="small" onClick={copy}>Copy angle</button>
              </div>
              <p>{r.ai.angle}</p>
              {r.ai.quoteStatus !== "none" && r.ai.evidenceQuote && (
                <div className={`quote${r.ai.quoteStatus === "verified" ? "" : " unv"}`}>
                  {r.ai.quoteStatus === "verified" ? <span className="q-lbl">From the launch page</span> : <span className="pill p-unverified" style={{ marginBottom: 4 }}>Unverified</span>}
                  “{r.ai.evidenceQuote}”
                </div>
              )}
            </div>
          )}
          {!r.votesHidden && <HowScored r={r} />}
        </div>
      )}
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
  const [noticeUntil, setNoticeUntil] = useState<number | null>(null); // when a "next copy in" countdown ends
  const [clock, setClock] = useState(() => Date.now());
  const [toast, setToast] = useState<string | null>(null);

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
      const n = (json as ScoutResponse).notification;
      setNoticeUntil(n?.status === "cooldown" && n.retryInSeconds ? Date.now() + n.retryInSeconds * 1000 : null);
      if ((json as ScoutResponse).source === "LIVE") {
        try { localStorage.setItem(LAST_VISIT_KEY, (json as ScoutResponse).generatedAt); } catch { /* storage blocked */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(null);
    }
  }

  useEffect(() => {
    if (noticeUntil === null) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [noticeUntil]);

  // One quiet line about the copy sent to Kavya. Shows nothing when sending is off, skipped, or already over.
  const notice = (() => {
    const n = data?.notification;
    if (!n) return null;
    const where = n.channels?.length === 2 ? "Telegram and email" : n.channels?.[0] === "telegram" ? "Telegram" : "email";
    if (n.status === "sending") return `Copy being sent to Kavya's ${where}`;
    if (n.status === "cooldown" && noticeUntil !== null) {
      const left = Math.ceil((noticeUntil - clock) / 1000);
      if (left > 0) return `Not sent: next copy in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    }
    return null;
  })();

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
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };
  const copyCsv = async () => {
    const rows = csvRows();
    const ok = await copyText(toCsv(rows));
    flash(ok ? `Copied ${rowsLabel(rows.length)}` : "Copy failed: use Download CSV instead");
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
    flash(`Downloaded ${rowsLabel(rows.length)}`);
  };
  const exportCount = data ? ranked.length + tooEarly.length + (moreOpen ? more.length : 0) : 0;

  const catCount = (id: CategoryId) => (data ? data.ranked.filter((r) => r.categories.includes(id)).length : 0);

  return (
    <main>
      <header className="head">
        <div className="head-text">
          <h1>ProductHunt <span className="dim">Partnership Scout</span></h1>
          <p className="sub">Launches from the last 7 days in project management, HR tech, developer productivity and team communication, ranked by upvotes and maker comments. It never contacts founders or sends outreach.</p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => run(false)} disabled={loading !== null}>{loading === "generate" ? "Generating…" : "Generate"}</button>
          <button onClick={() => run(true)} disabled={loading !== null || !data || refreshWaitMin > 0} title="Fetch the launch list again (once every 5 minutes)">
            {loading === "refresh" ? "Refreshing…" : refreshWaitMin > 0 ? `Refresh now (in ${refreshWaitMin} min)` : "Refresh now"}
          </button>
        </div>
      </header>

      {data && (
        <div className="status">
          <span className={`pill p-${data.source.toLowerCase()}`}>{data.source === "LIVE" && <span className="dot" aria-hidden="true" />}{data.source}</span>
          <span>{data.source === "SAMPLE" ? "bundled sample data from " : "fetched "}{fmtTime(data.fetchedAt)}</span>
          {notice && <div className="notice" role="status">{notice}</div>}
        </div>
      )}

      {loading && (
        <>
          <div className="banner info" role="status">Scanning Product Hunt and writing outreach angles. The first run can take up to a minute.</div>
          <div aria-hidden="true" style={{ marginTop: 24 }}><div className="skel" /><div className="skel" /><div className="skel" /></div>
        </>
      )}
      {error && <div className="banner err">{error}</div>}
      {data?.warnings.map((w, i) => <div key={i} className={`banner ${w.startsWith("AI summaries unavailable") || w.startsWith("Live Product Hunt") ? "err" : ""}`}>{w}</div>)}

      {data && (
        <>
          <div className="stats">
            <div className="stat"><div className="micro">Launches scanned</div><div className="num">{data.counted.of}</div></div>
            <div className="stat"><div className="micro">Maker comments counted</div><div className="num">{data.counted.n} <span>of {data.counted.of}</span></div></div>
            <div className="stat"><div className="micro">Provisional rows</div><div className="num">{provisionalRows}</div></div>
          </div>
          <div className="coverage" role="status">
            Maker comments counted for <b>{data.counted.n} of {data.counted.of}</b> launches.{" "}
            {provisionalRows > 0
              ? <>{provisionalRows} {provisionalRows === 1 ? "row is" : "rows are"} <b>Provisional</b>: {provisionalRows === 1 ? "its" : "their"} score is a lower bound until counted.</>
              : <>No row is Provisional.</>}
            {data.counted.stale > 0 && <> {data.counted.stale} {data.counted.stale === 1 ? "count comes" : "counts come"} from a saved copy older than 6 hours (CACHED).</>}
          </div>

          <div className="toolbar">
            <div className="chips" role="group" aria-label="Categories">
              <button className={`chip ${cat === "all" ? "on" : ""}`} aria-pressed={cat === "all"} onClick={() => setCat("all")}>All categories <span className="n">{data.ranked.length}</span></button>
              {CATEGORIES.map((c) => (
                <button key={c.id} className={`chip ${cat === c.id ? "on" : ""}`} aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.label} <span className="n">{catCount(c.id)}</span></button>
              ))}
            </div>
            <label className="switch">
              <input type="checkbox" checked={fitOnly} disabled={!data.ai.available} onChange={(e) => setFitOnly(e.target.checked)} />
              Strong and possible fit only
            </label>
          </div>

          <div className="listhead">
            <div>
              <h2>Ranked outreach list ({ranked.length})</h2>
              <p className="hint">In order of score. Filters only hide rows. Window: {fmtTime(data.window.from)} to {fmtTime(data.window.to)}.</p>
            </div>
            <div className="right">
              <span className="micro">Sorted by score</span>
              <button className="small" onClick={copyCsv} disabled={exportCount === 0}>Copy as CSV</button>
              <button className="small" onClick={downloadCsv} disabled={exportCount === 0}>Download CSV</button>
            </div>
          </div>
          <p className="hint" style={{ margin: "-4px 0 12px" }}>Exports the {rowsLabel(exportCount)} currently visible</p>
          {ranked.length === 0 && <div className="empty">No launches match. Widen the filters{data.counted.of === 0 ? `, or no launches were found between ${fmtTime(data.window.from)} and ${fmtTime(data.window.to)}` : ""}.</div>}
          {ranked.map((r, i) => <Row key={r.id} r={r} rank={data.ranked.indexOf(r) + 1 || i + 1} showNew={isNew(r)} aiShown index={i} onCopied={flash} />)}

          {data.tooEarly.length > 0 && (
            <section className="group">
              <h2>Too early to rank ({tooEarly.length})</h2>
              <p className="hint" style={{ margin: "0 0 12px" }}>Launched today; Product Hunt is still hiding the votes. They have no score yet and are not ranked.</p>
              {tooEarly.map((r) => <Row key={r.id} r={r} showNew={isNew(r)} aiShown={r.ai.angle !== ""} onCopied={flash} />)}
            </section>
          )}

          {data.moreLaunches.length > 0 && (
            <details className="group more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
              <summary>More launches ({more.length}), in score order, without an angle</summary>
              {more.map((r) => <Row key={r.id} r={r} rank={data.ranked.length + data.moreLaunches.indexOf(r) + 1} showNew={isNew(r)} aiShown={false} onCopied={flash} />)}
            </details>
          )}
        </>
      )}

      {!data && !loading && !error && <div className="empty">Click Generate to build today&apos;s list.</div>}

      <footer className="foot">
        <p>Review gate: you read the list and do all outreach yourself. The tool never contacts founders, never looks up emails and never sends outreach. When Kavya clicks Generate it also sends a copy of the list to her own Telegram and email.</p>
        <p>Live data comes from the Product Hunt API (non-commercial use); AI text comes from Gemini Flash and never changes the order. Source badge: LIVE = fetched from Product Hunt now or within the last hour, CACHED = an older saved copy after a failed refresh, SAMPLE = bundled demo data.</p>
      </footer>
      <div role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
    </main>
  );
}

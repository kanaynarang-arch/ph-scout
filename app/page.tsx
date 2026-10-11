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
    const done = setTimeout(() => setShown(value), 450); // never leave a stale number if frames are paused (background tab)
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [value, animate]);
  return <>{shown.toFixed(1)}</>;
}

/** A monogram tile: first letter on a muted tint derived from the name (no images, nothing fetched). */
function Tile({ name }: { name: string }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  return <span className="tile" aria-hidden="true" style={{ "--h": h } as React.CSSProperties}>{letter}</span>;
}

/** Score ring: the arc is the score out of 100. */
function Ring({ value, provisional, animate }: { value: number; provisional: boolean; animate: boolean }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={`ring${provisional ? " prov" : ""}`}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle className="trk" cx="30" cy="30" r={r} />
        <circle className={`prg${animate ? " go" : ""}`} cx="30" cy="30" r={r} strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 30 30)" />
      </svg>
      <span className="score"><Score value={value} animate={animate} /></span>
    </div>
  );
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
    <div className="how-wrap">
      <div className="micro">How this was scored</div>
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
      </dl>
      <p className="how-note">Only upvotes and maker comments count; fit, urgency and category never change the order.</p>
    </div>
  );
}

function Row({ r, rank, showNew, aiShown, index, onCopied }: { r: ScoredLaunch; rank?: number; showNew: boolean; aiShown: boolean; index?: number; onCopied: (msg: string) => void }) {
  const [open, setOpen] = useState(rank === 1);
  const copy = async () => {
    const ok = await copyText(r.ai.angle);
    onCopied(ok ? "Angle copied" : "Copy failed: select the text");
  };
  const competitor = aiShown && r.ai.fit === "competitor";
  const cls = ["lrow"];
  if (rank !== undefined && rank <= 3) cls.push(`top top${rank}`);
  if (competitor) cls.push("competitor");
  if (open) cls.push("open");
  if (index !== undefined && index < 10) cls.push("enter");
  const unverified = aiShown && r.ai.quoteStatus === "unverified" && r.ai.evidenceQuote;
  const detailId = `d-${r.id}`;
  return (
    <article className={cls.join(" ")} style={index !== undefined && index < 10 ? ({ "--i": index } as React.CSSProperties) : undefined}>
      <div className="c-rank">{rank !== undefined && <span className="rank">{rank}</span>}</div>
      <div className="c-prod">
        <Tile name={r.name} />
        <div className="pr-text">
        <div className="titleline">
          <a className="name" href={r.url} target="_blank" rel="noreferrer">{r.name}</a>
          {showNew && <span className="pill p-new">New since your last visit</span>}
          {aiShown && <span className={`pill p-${r.ai.fit}`}>{FIT_TEXT[r.ai.fit]}</span>}
          {r.provisional && <span className="pill p-provisional">Provisional</span>}
          {r.votesHidden && <span className="pill">Votes hidden</span>}
        </div>
        <div className="founder">Founder: <Founder r={r} /></div>
        <p className="desc">{r.ai.oneLiner}</p>
        </div>
      </div>
      <div className="c-angle">
        {aiShown ? (
          <>
            <p className="angle-prev">{r.ai.angle}</p>
            {unverified && <span className="pill p-unverified">Unverified quote</span>}
          </>
        ) : <span className="noangle">No angle for this launch</span>}
      </div>
      <div className="c-stats">
        <span className="mi"><IconUp /><b>{r.votesHidden ? "hidden" : r.votesCount}</b><span className="lbl">Upvotes</span></span>
        <span className="mi"><IconChat />{r.makerComments === null ? <b title="Maker comments not counted">not counted</b> : <><b>{r.makerComments}</b><span className="lbl">Maker comments</span></>}{r.makerCommentsStale && <span className="stale" title="Saved copy older than 6 hours; it will be refreshed on a later run">(CACHED)</span>}</span>
        <span className="mi"><IconDay /><b>{r.daysSinceLaunch}</b><span className="lbl">Days since launch</span></span>
      </div>
      <div className="c-score">
        {r.votesHidden ? <div className="hidden">votes hidden</div> : <Ring value={r.score} provisional={r.provisional} animate={index !== undefined && index < 10} />}
      </div>
      <button className="c-toggle" aria-expanded={open} aria-controls={detailId} aria-label={`${open ? "Hide" : "Show"} details for ${r.name}`} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="c-detail" id={detailId}>
          <div className="d-col">
            {aiShown && (
              <>
                <div className="micro">Suggested outreach angle</div>
                <p className="angle-full">{r.ai.angle}</p>
                {r.ai.quoteStatus !== "none" && r.ai.evidenceQuote && (
                  <div className={`quote${r.ai.quoteStatus === "verified" ? "" : " unv"}`}>
                    {r.ai.quoteStatus === "verified" ? <span className="q-lbl">From the launch page</span> : <span className="q-lbl">Unverified</span>}
                    “{r.ai.evidenceQuote}”
                  </div>
                )}
                <div className="d-actions">
                  <button className="small" onClick={copy}>Copy angle</button>
                  <span className="note">A starting point for you, not a message</span>
                </div>
              </>
            )}
          </div>
          <div className="d-col">
            {aiShown && r.ai.fitReason && <p className="fitline"><span className="micro">Fit</span><br />{r.ai.fitReason}</p>}
            <div className="urgrow"><span className={`urg urg-${r.urgency}`}><i aria-hidden="true" />{URGENCY_TEXT[r.urgency]}</span>{r.categories.length > 0 && <span className="cats">{r.categories.map(categoryLabel).join(" · ")}</span>}</div>
            {!r.votesHidden && <HowScored r={r} />}
          </div>
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

  const showHero = !data && !loading;
  const stateLine = data
    ? [
        <span key="r"><b>{data.ranked.length}</b> ranked</span>,
        <span key="s"><b>{data.counted.of}</b> launches scanned</span>,
        <span key="m">maker comments counted for <b>{data.counted.n} of {data.counted.of}</b><span className="meter" aria-hidden="true"><i style={{ width: `${data.counted.of ? Math.round((data.counted.n / data.counted.of) * 100) : 0}%` }} /></span></span>,
        <span key="p"><b>{provisionalRows}</b> provisional</span>,
      ]
    : [];

  return (
    <>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><defs><linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffb36b" /><stop offset="1" stopColor="#ff6a4d" /></linearGradient></defs></svg>
      <div className="topbar">
        <div className="topbar-in">
          <div className="brand"><span className="mark" aria-hidden="true" />ProductHunt <span className="dim">Partnership Scout</span></div>
          {!showHero && (
            <div className="actions">
              {data && <span className={`pill p-${data.source.toLowerCase()}`}>{data.source === "LIVE" && <span className="dot" aria-hidden="true" />}{data.source}<span className="when"> · {data.source === "SAMPLE" ? "bundled sample data from " : "fetched "}{fmtTime(data.fetchedAt)}</span></span>}
              <button onClick={() => run(true)} disabled={loading !== null || !data || refreshWaitMin > 0} title="Fetch the launch list again (once every 5 minutes)">
                {loading === "refresh" ? "Refreshing…" : refreshWaitMin > 0 ? `Refresh now (in ${refreshWaitMin} min)` : "Refresh now"}
              </button>
              <button className="primary" onClick={() => run(false)} disabled={loading !== null}>{loading === "generate" ? "Generating…" : "Generate"}</button>
            </div>
          )}
        </div>
      </div>

      <main>
        {showHero && (
          <section className="hero">
            <div className="hero-copy">
            <div className="micro">Partnerships · last 7 days on Product Hunt</div>
            <h1>Find the launches worth a conversation.</h1>
            <p className="sub">Launches from the last 7 days in project management, HR tech, developer productivity and team communication, ranked by upvotes and maker comments. It never contacts founders or sends outreach.</p>
            <div className="hero-actions">
              <button className="primary big" onClick={() => run(false)}>Generate</button>
              <span className="hint">Takes up to a minute the first time.</span>
            </div>
            </div>
            <div className="frame" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className={`fr-row fr-${i}`}>
                  <span className="fr-tile" /><span className="fr-lines"><i /><i /></span>
                  <svg viewBox="0 0 60 60"><circle className="trk" cx="30" cy="30" r="24" /><circle className="prg" cx="30" cy="30" r="24" strokeDasharray={`${[132, 104, 78][i]} 151`} transform="rotate(-90 30 30)" /></svg>
                </div>
              ))}
            </div>
            <ol className="steps">
              <li><span className="micro">01 · Scan</span><p>Product Hunt launches from the last 7 days across four categories, fetched live.</p></li>
              <li><span className="micro">02 · Rank</span><p>Half upvotes, half maker comments, each against the week&apos;s best. Computed in code.</p></li>
              <li><span className="micro">03 · Suggest</span><p>Gemini Flash writes an outreach angle backed by a quote from the launch page. It never changes the rank.</p></li>
            </ol>
          </section>
        )}

        {error && <div className="banner err">{error}</div>}
        {loading && (
          <>
            <div className="banner info" role="status">Scanning Product Hunt and writing outreach angles. The first run can take up to a minute.</div>
            <div className="table" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" />)}</div>
          </>
        )}
        {data?.warnings.map((w, i) => <div key={i} className={`banner ${w.startsWith("AI summaries unavailable") || w.startsWith("Live Product Hunt") ? "err" : ""}`}>{w}</div>)}

        {data && (
          <>
            <div className="summary" role="status">
              {stateLine.map((n, i) => <span key={i} className="sum-item">{n}</span>)}
              {notice && <span className="sum-item note">{notice}</span>}
            </div>
            {(provisionalRows > 0 || data.counted.stale > 0) && (
              <p className="hint cov">
                {provisionalRows > 0 && <>{provisionalRows} {provisionalRows === 1 ? "row is" : "rows are"} <b>Provisional</b>: {provisionalRows === 1 ? "its" : "their"} score is a lower bound until counted. </>}
                {data.counted.stale > 0 && <>{data.counted.stale} {data.counted.stale === 1 ? "count comes" : "counts come"} from a saved copy older than 6 hours (CACHED).</>}
              </p>
            )}

            <div className="toolbar">
              <div className="chips" role="group" aria-label="Categories">
                <button className={`chip ${cat === "all" ? "on" : ""}`} aria-pressed={cat === "all"} onClick={() => setCat("all")}>All <span className="n">{data.ranked.length}</span></button>
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
              <h2>Ranked outreach list <span className="count">{ranked.length}</span></h2>
              <div className="right">
                <span className="micro">Sorted by score</span>
                <button className="small" onClick={copyCsv} disabled={exportCount === 0}>Copy as CSV</button>
                <button className="small" onClick={downloadCsv} disabled={exportCount === 0}>Download CSV</button>
              </div>
            </div>
            <p className="hint" style={{ margin: "0 0 12px" }}>In order of score. Filters only hide rows. Window: {fmtTime(data.window.from)} to {fmtTime(data.window.to)}. Exports the {rowsLabel(exportCount)} currently visible.</p>
            {ranked.length === 0 && <div className="empty">No launches match. Widen the filters{data.counted.of === 0 ? `, or no launches were found between ${fmtTime(data.window.from)} and ${fmtTime(data.window.to)}` : ""}.</div>}
            {ranked.length > 0 && (
              <div className="table">
                <div className="thead" aria-hidden="true"><span>#</span><span>Product</span><span>Suggested outreach angle</span><span>Signals</span><span>Score</span><span /></div>
                {ranked.map((r, i) => <Row key={r.id} r={r} rank={data.ranked.indexOf(r) + 1 || i + 1} showNew={isNew(r)} aiShown index={i} onCopied={flash} />)}
              </div>
            )}

            {data.tooEarly.length > 0 && (
              <section className="group">
                <h2>Too early to rank <span className="count">{tooEarly.length}</span></h2>
                <p className="hint" style={{ margin: "0 0 12px" }}>Launched today; Product Hunt is still hiding the votes. They have no score yet and are not ranked.</p>
                <div className="table">{tooEarly.map((r) => <Row key={r.id} r={r} showNew={isNew(r)} aiShown={r.ai.angle !== ""} onCopied={flash} />)}</div>
              </section>
            )}

            {data.moreLaunches.length > 0 && (
              <details className="group more" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
                <summary>More launches ({more.length}), in score order, without an angle</summary>
                <div className="table">{more.map((r) => <Row key={r.id} r={r} rank={data.ranked.length + data.moreLaunches.indexOf(r) + 1} showNew={isNew(r)} aiShown={false} onCopied={flash} />)}</div>
              </details>
            )}
          </>
        )}

        <footer className="foot">
          <p>Review gate: you read the list and do all outreach yourself. The tool never contacts founders, never looks up emails and never sends outreach. When Kavya clicks Generate it also sends a copy of the list to her own Telegram and email.</p>
          <p>Live data comes from the Product Hunt API (non-commercial use); AI text comes from Gemini Flash and never changes the order. Source badge: LIVE = fetched from Product Hunt now or within the last hour, CACHED = an older saved copy after a failed refresh, SAMPLE = bundled demo data.</p>
        </footer>
        <div role="status" aria-live="polite">{toast && <div className="toast">{toast}</div>}</div>
      </main>
    </>
  );
}
